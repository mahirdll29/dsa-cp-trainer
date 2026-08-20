import { Prisma, Provider } from "@prisma/client";
import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import prisma from "../lib/prisma";
import { acquireSyncLock, completeSync, failSync } from "../lib/syncLock";
import { requireAuth } from "../middleware/requireAuth";
import { CodeforcesError, getUserInfo } from "../providers/codeforces/client";
import {
  syncCodeforcesUser,
  unlinkCodeforcesAccount,
} from "../providers/codeforces/sync";

const router = Router();

// Not one route in this file accepts a user identifier. req.userId goes straight into
// the WHERE clause, so another user's linked account is never fetched - there is no
// fetch-then-compare step, and therefore none to forget.

// A guard, not a gatekeeper: user.info is the authority on whether a handle exists,
// and on how long a handle may be. The 64 is a payload sanity bound and NOT
// Codeforces' real limit - an earlier version guessed 24, which rejected long
// nonexistent handles locally as "format is invalid" instead of letting the API
// answer "not found". That is the wrong answer twice over.
const HANDLE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

// Branching on the typed `kind` rather than message text, so an upstream rewording
// can never silently convert a 404 into a 500.
function statusForCodeforcesError(error: CodeforcesError): number {
  if (error.kind === "NOT_FOUND") return 404;
  return 502; // RATE_LIMITED, TIMEOUT, UNAVAILABLE, MALFORMED
}

function messageForCodeforcesError(error: CodeforcesError): string {
  switch (error.kind) {
    case "NOT_FOUND":
      return "Codeforces handle not found";
    case "RATE_LIMITED":
      return "Codeforces is rate limiting us, please try again in a minute";
    case "TIMEOUT":
      return "Codeforces did not respond in time, please try again";
    default:
      return "Codeforces is unavailable, please try again";
  }
}

// Link and sync are separate endpoints because validating a handle costs one cheap
// API call. Folding it into the import would mean a typo fails only after fetching,
// parsing and half-writing a full history.
router.post(
  "/link",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const { handle } = req.body ?? {};

    if (typeof handle !== "string" || handle.trim() === "") {
      return res.status(400).json({ error: "Handle is required" });
    }

    const trimmed = handle.trim();
    if (!HANDLE_PATTERN.test(trimmed)) {
      return res.status(400).json({ error: "Handle format is invalid" });
    }

    let canonicalHandle: string;
    try {
      const info = await getUserInfo(trimmed);
      // The API's casing wins, not the user's input: Codeforces matches handles
      // case-insensitively, so storing "MAHIRDLL" for the account "mahirdll" would leave
      // our data disagreeing with every link we render.
      canonicalHandle = info.handle;
    } catch (error) {
      if (error instanceof CodeforcesError) {
        return res
          .status(statusForCodeforcesError(error))
          .json({ error: messageForCodeforcesError(error) });
      }
      throw error;
    }

    // No pre-check that the link is free: findFirst-then-create is read-then-write and
    // two concurrent requests can both read "none exists". Only the compound unique is
    // atomic. Same reasoning as POST /api/auth/register.
    try {
      const linkedAccount = await prisma.linkedAccount.create({
        data: {
          userId: req.userId,
          provider: Provider.CODEFORCES,
          handle: canonicalHandle,
        },
        select: {
          id: true,
          provider: true,
          handle: true,
          syncStatus: true,
          lastSyncedAt: true,
          createdAt: true,
        },
      });

      return res.status(201).json({ linkedAccount });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return res
          .status(409)
          .json({ error: "A Codeforces account is already linked" });
      }
      throw error;
    }
  })
);

router.post(
  "/sync",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    // Query-scoped by userId - another user's account is never selected.
    const account = await prisma.linkedAccount.findUnique({
      where: {
        userId_provider: {
          userId: req.userId,
          provider: Provider.CODEFORCES,
        },
      },
      select: { id: true, handle: true },
    });

    if (!account) {
      return res
        .status(404)
        .json({ error: "No Codeforces account is linked" });
    }

    // The atomic compare-and-set and the stale-lock escape live in lib/syncLock.ts.
    if (!(await acquireSyncLock(account.id))) {
      return res.status(409).json({ error: "A sync is already in progress" });
    }

    try {
      const result = await syncCodeforcesUser(
        req.userId,
        account.id,
        account.handle
      );

      // lastSyncedAt advances ONLY on success: moving it on failure would claim a freshness
      // we do not have.
      await completeSync(account.id);

      return res.json({ handle: account.handle, ...result });
    } catch (error) {
      // A failed import is a recoverable state, never a crash. Moving to FAILED releases
      // the lock so the user can retry immediately.
      await failSync(account.id);

      if (error instanceof CodeforcesError) {
        return res
          .status(statusForCodeforcesError(error))
          .json({ error: messageForCodeforcesError(error) });
      }

      // Anything else is our bug, not theirs - re-throw so it is logged. The status is
      // already FAILED, so the account is not left stranded.
      throw error;
    }
  })
);

// Sync state is read from OUR database, never from Codeforces on a page load.
router.get(
  "/status",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const account = await prisma.linkedAccount.findUnique({
      where: {
        userId_provider: {
          userId: req.userId,
          provider: Provider.CODEFORCES,
        },
      },
      select: { handle: true, syncStatus: true, lastSyncedAt: true },
    });

    if (!account) {
      return res
        .status(404)
        .json({ error: "No Codeforces account is linked" });
    }

    return res.json(account);
  })
);

// Deletes the link AND the Codeforces solve history it produced, then rebuilds
// mastery. RevisionItem rows survive. Reasoning in providers/codeforces/sync.ts.
router.delete(
  "/link",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const account = await prisma.linkedAccount.findUnique({
      where: {
        userId_provider: {
          userId: req.userId,
          provider: Provider.CODEFORCES,
        },
      },
      select: { id: true },
    });

    if (!account) {
      return res
        .status(404)
        .json({ error: "No Codeforces account is linked" });
    }

    // Take the same lock the sync takes. Unlinking deletes the UserProblem rows a
    // running import is still writing and then recomputes mastery from the result, so
    // without this the two interleave: rows survive the purge, or the importer's own
    // completeSync/failSync hits a LinkedAccount row that no longer exists.
    if (!(await acquireSyncLock(account.id))) {
      return res.status(409).json({ error: "A sync is already in progress" });
    }

    const result = await unlinkCodeforcesAccount(req.userId, account.id);

    return res.json({ unlinked: true, ...result });
  })
);

export default router;
