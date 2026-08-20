import { Prisma, Provider } from "@prisma/client";
import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import prisma from "../lib/prisma";
import { acquireSyncLock, completeSync, failSync } from "../lib/syncLock";
import { requireAuth } from "../middleware/requireAuth";
import { LeetcodeError, getProfile } from "../providers/leetcode/client";
import {
  syncLeetcodeUser,
  unlinkLeetcodeAccount,
} from "../providers/leetcode/sync";

const router = Router();

// Not one route in this file accepts a user identifier. req.userId goes straight into
// the WHERE clause, so another user's linked account is never fetched.
//
// This file DUPLICATES routes/codeforces.ts rather than sharing it. The lock
// lifecycle moved to lib/syncLock.ts because divergence there is a silent
// correctness bug; what is left differs on every line by a visible constant, and a
// shared router factory would mean reading two files to understand one endpoint.

// A guard, not a gatekeeper. The 64 is a payload sanity bound, NOT LeetCode's real
// rule, which we do not know and must not guess.
const HANDLE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

// Branching on the typed `kind` rather than message text, so an upstream rewording
// can never silently convert a 404 into a 500.
function statusForLeetcodeError(error: LeetcodeError): number {
  if (error.kind === "NOT_FOUND") return 404;
  return 502; // RATE_LIMITED, TIMEOUT, UNAVAILABLE, MALFORMED
}

function messageForLeetcodeError(error: LeetcodeError): string {
  switch (error.kind) {
    case "NOT_FOUND":
      return "LeetCode username not found";
    case "RATE_LIMITED":
      // NOT "try again in a minute": the quota is 120 requests per HOUR and a breach is
      // answered with retry-after ~1400 seconds. Telling the user to retry shortly would
      // send them into a loop that cannot succeed.
      return "The LeetCode API rate limit has been reached (120 requests/hour). Please try again later";
    case "TIMEOUT":
      return "LeetCode did not respond in time, please try again";
    default:
      return "The LeetCode API is unavailable, please try again";
  }
}

// THE ONLY PLACE A BAD USERNAME CAN BE CAUGHT, and that is forced by the API rather
// than chosen: /:username/acSubmission for a nonexistent user returns 200
// {"count":0,"submission":[]}, byte-identical to a real user who has solved nothing.
// So the sync endpoint structurally cannot tell a typo from an empty account.
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
      const profile = await getProfile(trimmed);
      // The API's spelling wins, not the user's input: LeetCode matches usernames
      // case-insensitively.
      canonicalHandle = profile.username;
    } catch (error) {
      if (error instanceof LeetcodeError) {
        return res
          .status(statusForLeetcodeError(error))
          .json({ error: messageForLeetcodeError(error) });
      }
      throw error;
    }

    // No pre-check that the link is free: read-then-write has a window that `await`
    // opens. Only the compound unique is atomic - and it is on the PAIR, so this row
    // coexists with the user's Codeforces row rather than competing with it.
    try {
      const linkedAccount = await prisma.linkedAccount.create({
        data: {
          userId: req.userId,
          provider: Provider.LEETCODE,
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
          .json({ error: "A LeetCode account is already linked" });
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
        userId_provider: { userId: req.userId, provider: Provider.LEETCODE },
      },
      select: { id: true, handle: true },
    });

    if (!account) {
      return res.status(404).json({ error: "No LeetCode account is linked" });
    }

    // The atomic compare-and-set and the stale-lock escape live in lib/syncLock.ts.
    if (!(await acquireSyncLock(account.id))) {
      return res.status(409).json({ error: "A sync is already in progress" });
    }

    try {
      const result = await syncLeetcodeUser(req.userId, account.handle);

      // lastSyncedAt advances ONLY on the success path.
      await completeSync(account.id);

      return res.json({ handle: account.handle, ...result });
    } catch (error) {
      // A failed import is a recoverable state, never a crash. This path matters more here
      // than for Codeforces: the upstream is an unofficial wrapper on free hosting, so
      // "the provider is down" is a normal outcome, not an exotic one.
      await failSync(account.id);

      if (error instanceof LeetcodeError) {
        return res
          .status(statusForLeetcodeError(error))
          .json({ error: messageForLeetcodeError(error) });
      }

      // Anything else is our bug, not theirs - re-throw so it is logged. The status is
      // already FAILED, so the account is not left stranded.
      throw error;
    }
  })
);

// Sync state is read from OUR database, never from the wrapper on a page load -
// which matters doubly when the upstream can cold-start for 30-60 seconds.
router.get(
  "/status",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const account = await prisma.linkedAccount.findUnique({
      where: {
        userId_provider: { userId: req.userId, provider: Provider.LEETCODE },
      },
      select: { handle: true, syncStatus: true, lastSyncedAt: true },
    });

    if (!account) {
      return res.status(404).json({ error: "No LeetCode account is linked" });
    }

    return res.json(account);
  })
);

// Identical semantics to the Codeforces route - two providers behaving differently
// on unlink would be a bug. Reasoning in providers/leetcode/sync.ts.
router.delete(
  "/link",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const account = await prisma.linkedAccount.findUnique({
      where: {
        userId_provider: { userId: req.userId, provider: Provider.LEETCODE },
      },
      select: { id: true },
    });

    if (!account) {
      return res.status(404).json({ error: "No LeetCode account is linked" });
    }

    // Take the same lock the sync takes. Unlinking deletes the UserProblem rows a
    // running import is still writing and then recomputes mastery from the result, so
    // without this the two interleave: rows survive the purge, or the importer's own
    // completeSync/failSync hits a LinkedAccount row that no longer exists.
    if (!(await acquireSyncLock(account.id))) {
      return res.status(409).json({ error: "A sync is already in progress" });
    }

    const result = await unlinkLeetcodeAccount(req.userId, account.id);

    return res.json({ unlinked: true, ...result });
  })
);

export default router;
