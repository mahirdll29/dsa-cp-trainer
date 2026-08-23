"use client";

import { absoluteTime } from "@/lib/format";
import type { ContestSummary } from "@/lib/types";

// A plain list. The count shown is the confirmed one once reconciliation has run and
// the claimed one before, and the row says which it is - averaging the two into a
// single number would make a checked contest and an unchecked one look alike.

function outcomeLabel(status: ContestSummary["status"]): string {
  return status === "ABANDONED" ? "ended early" : "completed";
}

export function ContestHistory({
  contests,
  onSelect,
}: {
  contests: ContestSummary[];
  onSelect: (contestId: string) => void;
}) {
  return (
    <ol className="border-rule border-t">
      {contests.map((contest) => {
        const reconciled = contest.reconciledAt !== null;
        return (
          <li key={contest.id} className="border-rule border-b last:border-b-0">
            <button
              type="button"
              onClick={() => onSelect(contest.id)}
              className="hover:bg-surface flex w-full flex-wrap items-start gap-x-4 gap-y-2 py-4 text-left"
            >
              <span
                className={`t-data-xs w-24 shrink-0 pt-1 text-right ${
                  contest.status === "ABANDONED" ? "text-deficit" : "text-surplus"
                }`}
              >
                {outcomeLabel(contest.status)}
              </span>

              <span className="min-w-0 flex-1">
                <span className="t-body-sm text-ink block font-medium">
                  {contest.durationMinutes} minutes · {contest.size} problems
                </span>
                <span className="t-data-xs text-quiet mt-1 block">
                  {reconciled
                    ? `${contest.confirmed} confirmed`
                    : `${contest.claimed} marked · not checked`}{" "}
                  · {absoluteTime(contest.startedAt)}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
