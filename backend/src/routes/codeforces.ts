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

// ---------------------------------------------------------------------------
// OWNERSHIP — identical discipline to the Module 3 routes.
//
// NOT ONE ROUTE IN THIS FILE ACCEPTS A USER IDENTIFIER. req.userId goes
// straight into the WHERE clause of every query, so another user's linked
// account is never FETCHED, let alone returned. There is no fetch-then-compare
// step, which means there is no fetch-then-compare step to forget — the
// scoping IS the query.
//
// CSRF: requireSameOrigin is registered globally in app.ts and treats only
// GET/HEAD/OPTIONS as safe, so the three non-GET routes below are covered with
// no per-route work. Non-browser clients (curl, Postman) must send an Origin
// header or they get a 403.
// ---------------------------------------------------------------------------

// Codeforces handles use a restricted character set. This check is a GUARD,
// NOT A GATEKEEPER: user.info is the authority on whether a handle exists, and
// deliberately also on how long a handle may be.
//
// THE LENGTH BOUND IS 64 AND THAT NUMBER IS NOT CODEFORCES' LIMIT — it is a
// payload sanity bound and nothing more. Caught during verification: an
// earlier version capped this at 24 (a guess at Codeforces' real limit), which
// meant a long nonexistent handle was rejected locally with 400 "format is
// invalid" instead of reaching the API and coming back 404 "not found". That
// is the wrong answer twice over — it reports a format problem for what is
// really an existence problem, and it encodes a guess about somebody else's
// validation rules as our own hard failure. If Codeforces ever allows a
// 30-character handle, a user with one would be told their valid handle is
// invalid, with no way to understand why.
//
// ACCEPTED COST: junk that passes the charset check now costs one API call
// (and 2.1 s of rate-limit budget) before being rejected. Cheap, and it buys
// an error message that is actually true.
const HANDLE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

// Turn a provider failure into an HTTP status. Branching on the typed `kind`
// rather than on message text means an upstream rewording can never silently
// convert a 404 into a 500.
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

// ---------------------------------------------------------------------------
// POST /api/integrations/codeforces/link
//
// WHY LINKING AND SYNCING ARE SEPARATE ENDPOINTS. Validating the handle costs
// exactly one cheap API call. Folding it into the import would mean a typo'd
// handle fails only after we have fetched, parsed and half-written a full
// history — slow, and it leaves a PENDING account behind.
//
// TRADEOFF, STATED: four endpoints instead of two, and a client has to make two
// calls to onboard a user.
// ---------------------------------------------------------------------------
router.post(
  "/link",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    // Hand-written validation, consistent with the rest of the project. No Zod.
    const { handle } = req.body ?? {};

    if (typeof handle !== "string" || handle.trim() === "") {
      return res.status(400).json({ error: "Handle is required" });
    }

    const trimmed = handle.trim();
    if (!HANDLE_PATTERN.test(trimmed)) {
      return res.status(400).json({ error: "Handle format is invalid" });
    }

    // Prove the handle exists BEFORE creating anything. A CodeforcesError with
    // kind NOT_FOUND becomes a 404 below.
    let canonicalHandle: string;
    try {
      const info = await getUserInfo(trimmed);
      // THE API'S CASING WINS, not the user's input. Codeforces looks handles
      // up case-insensitively, so storing "MAHIRDLL" when the account is
      // "mahirdll" would leave our own data disagreeing with every link we
      // render and every future lookup.
      canonicalHandle = info.handle;
    } catch (error) {
      if (error instanceof CodeforcesError) {
        return res
          .status(statusForCodeforcesError(error))
          .json({ error: messageForCodeforcesError(error) });
      }
      throw error;
    }

    // NO PRE-CHECK THAT THE LINK IS FREE. A findFirst-then-create is
    // read-then-write, and two concurrent requests can both read "none exists"
    // before either writes — `await` yields the event loop, so single-threaded
    // Node does not close that window. Only @@unique([userId, provider]) is
    // atomic. Identical reasoning to POST /api/auth/register catching P2002.
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

// ---------------------------------------------------------------------------
// POST /api/integrations/codeforces/sync — the real import
// ---------------------------------------------------------------------------
router.post(
  "/sync",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    // Query-scoped by userId — another user's account cannot be reached from
    // here because it is never selected.
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

    // ACQUIRE THE LOCK. The atomic compare-and-set and the stale-lock escape
    // both live in lib/syncLock.ts, shared with the LeetCode route — see that
    // file for why this specific piece was worth extracting when the
    // surrounding handlers were not.
    if (!(await acquireSyncLock(account.id))) {
      return res.status(409).json({ error: "A sync is already in progress" });
    }

    try {
      const result = await syncCodeforcesUser(
        req.userId,
        account.id,
        account.handle
      );

      // lastSyncedAt advances ONLY here, on the success path. Moving it on
      // failure would claim a freshness we do not have.
      await completeSync(account.id);

      return res.json({ handle: account.handle, ...result });
    } catch (error) {
      // A FAILED IMPORT IS A RECOVERABLE STATE, NEVER A CRASH. The lock is
      // released by moving to FAILED, so the user can retry immediately
      // instead of waiting out the staleness window.
      await failSync(account.id);

      if (error instanceof CodeforcesError) {
        return res
          .status(statusForCodeforcesError(error))
          .json({ error: messageForCodeforcesError(error) });
      }

      // Anything else is our bug, not theirs. Re-throw so asyncHandler routes
      // it to the error handler and it gets logged server-side — but the
      // status is already FAILED, so the account is not left stranded.
      throw error;
    }
  })
);

// ---------------------------------------------------------------------------
// GET /api/integrations/codeforces/status
//
// This is the endpoint that makes the caching rule real: the frontend reads
// sync state from OUR database and never touches Codeforces on a page load.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// DELETE /api/integrations/codeforces/link
//
// Deletes the link AND the Codeforces solve history it produced, then rebuilds
// mastery. RevisionItem rows survive. The full reasoning — including why
// leaving the data behind would silently merge two people's histories into one
// mastery profile — is in providers/codeforces/sync.ts above
// unlinkCodeforcesAccount.
// ---------------------------------------------------------------------------
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

    const result = await unlinkCodeforcesAccount(req.userId, account.id);

    return res.json({ unlinked: true, ...result });
  })
);

export default router;
