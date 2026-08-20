import { SyncStatus } from "@prisma/client";
import prisma from "./prisma";

// The LinkedAccount sync lock, shared by both providers.
//
// This is the one piece of the provider routes that was extracted, because it is the
// one place DIVERGENCE IS A SILENT CORRECTNESS BUG: a copy-pasted version with a
// different stale window, or one that forgot the FAILED write on the error path,
// passes every happy-path test and then strands an account in SYNCING forever.

// A SYNC IS A LOCK, AND LOCKS STRAND. If the process dies mid-import nothing writes
// COMPLETED or FAILED, the row sits at SYNCING forever, and the user can never sync
// again - there is no timeout on a database column. So the lock has an expiry.
//
// One constant, both providers: two copies would drift the first time somebody tuned
// one.
const STALE_SYNC_MS = 5 * 60 * 1000;

// An ATOMIC COMPARE-AND-SET, not a read-then-write. Written the obvious way ("read
// the row; is it SYNCING? no? then set SYNCING") two requests both read "not
// syncing" and both import - `await` yields the event loop, so single-threaded Node
// does not close that window. Putting the condition in the WHERE clause makes the
// DATABASE decide, and `count` reports whether we won.
//
// The OR is the stale-lock escape. updatedAt is @updatedAt, so writing SYNCING stamps
// the acquisition time for free and no extra column is needed.
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

// lastSyncedAt advances ONLY here, on success. Moving it on failure would claim a
// freshness we do not have, and the UI would report the data as current.
export async function completeSync(linkedAccountId: string): Promise<void> {
  await prisma.linkedAccount.update({
    where: { id: linkedAccountId },
    data: { syncStatus: SyncStatus.COMPLETED, lastSyncedAt: new Date() },
  });
}

// A failed import is a recoverable state, never a crash. Moving to FAILED releases
// the lock, so the user can retry immediately rather than waiting out the stale
// window. lastSyncedAt is deliberately left untouched.
export async function failSync(linkedAccountId: string): Promise<void> {
  await prisma.linkedAccount.update({
    where: { id: linkedAccountId },
    data: { syncStatus: SyncStatus.FAILED },
  });
}
