"use client";

import type { SyncStatus } from "@/lib/types";

// SyncStatus rendered as a word, never as a bare colour: the four states are not on
// one axis, so the label carries the meaning and the tint only reinforces it.

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
