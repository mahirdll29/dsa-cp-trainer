import { SyncStatus } from "@prisma/client";
import prisma from "./prisma";

// Shared by both providers: a divergent copy is a silent correctness bug.

// Locks strand. A process that dies mid-import never writes COMPLETED or FAILED, and
// there is no timeout on a database column - so the lock needs an expiry of its own.
const STALE_SYNC_MS = 5 * 60 * 1000;

// The condition lives in the WHERE clause so the DATABASE decides who wins; a
// read-then-write here would let two requests both see "not syncing" and both import.
// The OR is the stale-lock escape, dated by @updatedAt for free.
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
