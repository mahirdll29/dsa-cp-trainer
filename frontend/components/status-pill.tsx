"use client";

import type { SyncStatus } from "@/lib/types";

// ---------------------------------------------------------------------------
// The four real values of LinkedAccount.syncStatus, rendered honestly.
//
// COLOUR IS NOT THE ONLY SIGNAL: the word is always printed. A pill that showed
// a red dot and nothing else would put the most important state in the app
// behind a hue.
//
// PENDING is the state a freshly linked account sits in before its first sync,
// and it is rendered in --quiet rather than a warning colour on purpose. It is
// not a problem; it means "nothing has happened yet", which is exactly what
// --quiet means everywhere else in this interface.
// ---------------------------------------------------------------------------

const LABEL: Record<SyncStatus, string> = {
  PENDING: "Never synced",
  SYNCING: "Syncing",
  COMPLETED: "Synced",
  FAILED: "Sync failed",
};

const COLOR: Record<SyncStatus, string> = {
  PENDING: "text-quiet",
  SYNCING: "text-median",
  COMPLETED: "text-surplus",
  FAILED: "text-deficit",
};

export function StatusPill({ status }: { status: SyncStatus }) {
  return (
    <span className={`t-data-xs ${COLOR[status]} uppercase tracking-[0.12em]`}>
      {LABEL[status]}
    </span>
  );
}
