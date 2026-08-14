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

// ---------------------------------------------------------------------------
// OWNERSHIP — identical discipline to routes/codeforces.ts.
//
// NOT ONE ROUTE IN THIS FILE ACCEPTS A USER IDENTIFIER. req.userId goes
// straight into the WHERE clause of every query, so another user's linked
// account is never FETCHED, let alone returned. There is no fetch-then-compare
// step, which means there is no fetch-then-compare step to forget.
//
// CSRF: requireSameOrigin is registered globally in app.ts and treats only
// GET/HEAD/OPTIONS as safe, so the three non-GET routes below are covered with
// no per-route work.
//
// WHY THIS FILE DUPLICATES routes/codeforces.ts RATHER THAN SHARING IT.
// Module 5 measured the overlap: of 199 code lines in routes/codeforces.ts,
// roughly 90 are near-verbatim. But the lock lifecycle (33 of those lines) is
// the only part where divergence is a SILENT CORRECTNESS BUG, so that is what
// moved to lib/syncLock.ts. What is left differs on every line by a visible
// constant — Provider.LEETCODE, the wording of each error, which sync function
// to call. Folding it into a shared router factory would mean holding two files
// in your head to read one endpoint, and it would immediately need
// provider-specific branches for the error translation below.
//
// That is CLAUDE.md's tradeoff taken deliberately: simple and readable over
// DRY, with the one genuinely dangerous piece extracted.
// ---------------------------------------------------------------------------

// A GUARD, NOT A GATEKEEPER — same call Module 4 made and for the same reason.
// The wrapper is the authority on whether a username exists; this only stops
// obvious junk from costing an API call. The 64-char bound is a payload sanity
// limit, NOT LeetCode's real rule, which we do not know and must not guess: a
// too-tight guess would reject a valid username with a misleading "format is
// invalid" instead of letting the API answer honestly.
const HANDLE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

// Turn a provider failure into an HTTP status. Branching on the typed `kind`
// rather than on message text means an upstream rewording can never silently
// convert a 404 into a 500.
function statusForLeetcodeError(error: LeetcodeError): number {
  if (error.kind === "NOT_FOUND") return 404;
  return 502; // RATE_LIMITED, TIMEOUT, UNAVAILABLE, MALFORMED
}

function messageForLeetcodeError(error: LeetcodeError): string {
  switch (error.kind) {
    case "NOT_FOUND":
      return "LeetCode username not found";
    case "RATE_LIMITED":
      // NOT "try again in a minute" — measured, the wrapper's quota is 120
      // requests per HOUR per IP and it answers a breach with
      // retry-after: ~1400 seconds. Telling the user to retry shortly would
      // send them into a loop that cannot succeed.
      return "The LeetCode API rate limit has been reached (120 requests/hour). Please try again later";
    case "TIMEOUT":
      return "LeetCode did not respond in time, please try again";
    default:
      return "The LeetCode API is unavailable, please try again";
  }
}

// ---------------------------------------------------------------------------
// POST /api/integrations/leetcode/link
//
// THE ONLY PLACE A BAD USERNAME CAN BE CAUGHT, and that is not a design
// preference — it is forced by the API. Verified against the live wrapper:
// /:username/acSubmission for a nonexistent user returns HTTP 200 with
// {"count":0,"submission":[]}, which is byte-identical to a real user who has
// solved nothing. So the sync endpoint structurally CANNOT tell a typo from an
// empty account. /:username is the one endpoint that can, and this is where it
// gets called.
//
// That makes the link/sync split more load-bearing here than it was for
// Codeforces, where it was mainly about failing fast and cheaply.
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

    // Prove the username exists BEFORE creating anything.
    let canonicalHandle: string;
    try {
      const profile = await getProfile(trimmed);
      // THE API'S SPELLING WINS, not the user's input. LeetCode matches
      // usernames case-insensitively, so storing "MahirDLL" for the account
      // "mahirdll" would leave our data disagreeing with every profile link we
      // render and every future lookup.
      canonicalHandle = profile.username;
    } catch (error) {
      if (error instanceof LeetcodeError) {
        return res
          .status(statusForLeetcodeError(error))
          .json({ error: messageForLeetcodeError(error) });
      }
      throw error;
    }

    // NO PRE-CHECK THAT THE LINK IS FREE. findFirst-then-create is
    // read-then-write, and two concurrent requests can both read "none exists"
    // before either writes — `await` yields the event loop, so single-threaded
    // Node does not close that window. Only @@unique([userId, provider]) is
    // atomic. Identical reasoning to POST /api/auth/register catching P2002.
    //
    // That unique is on the PAIR, so this row coexists with the user's
    // Codeforces row rather than competing with it.
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

// ---------------------------------------------------------------------------
// POST /api/integrations/leetcode/sync — the import
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
        userId_provider: { userId: req.userId, provider: Provider.LEETCODE },
      },
      select: { id: true, handle: true },
    });

    if (!account) {
      return res.status(404).json({ error: "No LeetCode account is linked" });
    }

    // ACQUIRE THE LOCK. The atomic compare-and-set and the stale-lock escape
    // live in lib/syncLock.ts, shared with the Codeforces route.
    if (!(await acquireSyncLock(account.id))) {
      return res.status(409).json({ error: "A sync is already in progress" });
    }

    try {
      const result = await syncLeetcodeUser(req.userId, account.handle);

      // lastSyncedAt advances ONLY on the success path — see lib/syncLock.ts.
      await completeSync(account.id);

      return res.json({ handle: account.handle, ...result });
    } catch (error) {
      // A FAILED IMPORT IS A RECOVERABLE STATE, NEVER A CRASH. Moving to FAILED
      // releases the lock so the user can retry immediately instead of waiting
      // out the staleness window. This path matters more here than for
      // Codeforces: the upstream is an unofficial wrapper on free hosting, so
      // "the provider is down" is a NORMAL outcome, not an exotic one.
      await failSync(account.id);

      if (error instanceof LeetcodeError) {
        return res
          .status(statusForLeetcodeError(error))
          .json({ error: messageForLeetcodeError(error) });
      }

      // Anything else is our bug, not theirs. Re-throw so asyncHandler routes
      // it to the error handler and it gets logged server-side — the status is
      // already FAILED, so the account is not left stranded.
      throw error;
    }
  })
);

// ---------------------------------------------------------------------------
// GET /api/integrations/leetcode/status
//
// This is the endpoint that makes the caching rule real: the frontend reads
// sync state from OUR database and never touches the wrapper on a page load —
// which matters doubly when the upstream can cold-start for 30-60 seconds.
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

// ---------------------------------------------------------------------------
// DELETE /api/integrations/leetcode/link
//
// Deletes the link AND the LeetCode solve history it produced, then rebuilds
// mastery. RevisionItem rows survive. IDENTICAL SEMANTICS to the Codeforces
// route — two providers behaving differently on unlink would be a bug. The full
// reasoning is in providers/leetcode/sync.ts above unlinkLeetcodeAccount.
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
        userId_provider: { userId: req.userId, provider: Provider.LEETCODE },
      },
      select: { id: true },
    });

    if (!account) {
      return res.status(404).json({ error: "No LeetCode account is linked" });
    }

    const result = await unlinkLeetcodeAccount(req.userId, account.id);

    return res.json({ unlinked: true, ...result });
  })
);

export default router;
