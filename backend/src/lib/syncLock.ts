import { SyncStatus } from "@prisma/client";
import prisma from "./prisma";

// ---------------------------------------------------------------------------
// THE LINKED-ACCOUNT SYNC LOCK — shared by both providers.
//
// WHY THIS IS THE ONE THING MODULE 5 EXTRACTED.
//
// CLAUDE.md's bar is "no service layer unless the logic genuinely has two
// callers". With two providers, a lot of the route code now has two callers —
// but most of it is Express boilerplate where every line differs by a visible
// constant (Provider.CODEFORCES vs Provider.LEETCODE, "No Codeforces account is
// linked" vs the LeetCode wording). Sharing that would mean reading two files
// to understand one endpoint, so routes/leetcode.ts deliberately DUPLICATES
// link, status and unlink.
//
// This is different, and the difference is the point: it is the one place where
// DIVERGENCE IS A SILENT CORRECTNESS BUG. A copy-pasted LeetCode version with a
// slightly different stale window, or one that forgot the FAILED write on the
// error path, would pass every happy-path test and then strand a user's account
// in SYNCING forever with no way to retry. That bug is invisible until somebody
// hits it.
//
// It is also genuinely provider-agnostic: it touches only LinkedAccount's own
// lifecycle columns and takes nothing but an id. There is no provider knowledge
// to parameterise away, which is what separates a real shared helper from a
// premature abstraction with a `provider` flag threaded through it.
// ---------------------------------------------------------------------------

// A SYNC IS A LOCK, AND LOCKS STRAND.
//
// syncStatus = SYNCING is a mutex: it stops two imports for the same account
// running at once. But if the process dies mid-import — a deploy, an OOM, a
// pulled plug — nothing ever writes COMPLETED or FAILED, the row sits at
// SYNCING forever, and the user can NEVER sync again. There is no timeout on a
// database column.
//
// So the lock needs an expiry. Any SYNCING older than this is treated as
// abandoned and may be reclaimed. Five minutes is comfortably longer than the
// slowest observed sync (~20 s for Codeforces, ~25 s worst case for LeetCode
// with a full set of /select gap lookups) while still being a short wait for a
// user who hit a genuine crash.
//
// ONE CONSTANT, BOTH PROVIDERS — which is itself a reason this file exists.
// Two copies of this number would drift the first time somebody tuned one.
const STALE_SYNC_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// ACQUIRE — an ATOMIC COMPARE-AND-SET, not a read-then-write.
//
// Written the obvious way ("read the row; is it SYNCING? no? then set SYNCING")
// this would have the same race as every other check-then-act in this project:
// two requests both read "not syncing", both proceed, both import. `await`
// yields the event loop, so single-threaded Node does not close that window.
//
// Putting the condition inside the WHERE clause makes the DATABASE decide, and
// `count` reports whether we won. Exactly one caller can observe count === 1.
//
// The OR is the stale-lock escape. updatedAt is @updatedAt, so the act of
// writing SYNCING stamps the acquisition time for free — the lock's age is
// simply its last write, and no extra column is needed.
//
// Returns true if this caller now holds the lock.
// ---------------------------------------------------------------------------
export async function acquireSyncLock(
  linkedAccountId: string
): Promise<boolean> {
  const staleCutoff = new Date(Date.now() - STALE_SYNC_MS);

  const acquired = await prisma.linkedAccount.updateMany({
    where: {
      id: linkedAccountId,
      OR: [
        { syncStatus: { not: SyncStatus.SYNCING } },
        { updatedAt: { lt: staleCutoff } },
      ],
    },
    data: { syncStatus: SyncStatus.SYNCING },
  });

  return acquired.count === 1;
}

// ---------------------------------------------------------------------------
// RELEASE, SUCCESS.
//
// lastSyncedAt advances ONLY here. That is a deliberate decision (Module 4
// decision 33): moving it on failure would claim a freshness we do not have,
// and the UI would tell the user their data was current when the import had
// actually failed.
// ---------------------------------------------------------------------------
export async function completeSync(linkedAccountId: string): Promise<void> {
  await prisma.linkedAccount.update({
    where: { id: linkedAccountId },
    data: { syncStatus: SyncStatus.COMPLETED, lastSyncedAt: new Date() },
  });
}

// ---------------------------------------------------------------------------
// RELEASE, FAILURE.
//
// A FAILED IMPORT IS A RECOVERABLE STATE, NEVER A CRASH. Moving to FAILED
// releases the lock, so the user can retry IMMEDIATELY rather than waiting out
// the five-minute staleness window.
//
// lastSyncedAt is deliberately left untouched — see completeSync.
// ---------------------------------------------------------------------------
export async function failSync(linkedAccountId: string): Promise<void> {
  await prisma.linkedAccount.update({
    where: { id: linkedAccountId },
    data: { syncStatus: SyncStatus.FAILED },
  });
}
