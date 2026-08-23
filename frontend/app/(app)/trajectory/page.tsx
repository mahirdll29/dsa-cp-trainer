"use client";

import { TrajectorySeries, TrajectorySummary } from "@/components/trajectory";
import { EmptyState, ErrorState, SpreadSkeleton } from "@/components/states";
import { api } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import type { SummaryResponse, TrajectoryResponse } from "@/lib/types";

// Mastery over time. Every number here is bucketed, classified and ordered on the
// server - this page sends its own UTC offset so days break where the user's day
// breaks, and renders what comes back.
//
// Two fetches rather than one: the summary reads solve history as well as the log, so
// awaiting both before painting would hold the sparklines hostage to the slower query.

// Minutes AHEAD of UTC, the opposite sign to what getTimezoneOffset returns. Getting
// this backwards does not fail, it silently files every late-evening row under the
// wrong day.
function tzOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}

export default function TrajectoryPage() {
  const trajectory = useResource(() =>
    api<TrajectoryResponse>(
      `/api/analytics/trajectory?days=90&tzOffsetMinutes=${tzOffsetMinutes()}`
    )
  );
  const summary = useResource(() =>
    api<SummaryResponse>(
      `/api/analytics/summary?days=90&tzOffsetMinutes=${tzOffsetMinutes()}`
    )
  );

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-6">
      <h1 className="t-display">Trajectory</h1>
      <p className="t-body-sm text-quiet mt-1 max-w-prose">
        Mastery is recorded only when it changes, so these lines are what actually
        moved. Where a topic lost its data the line stops rather than continuing at the
        last value it had.
      </p>

      <div className="mt-8">
        {summary.loading ? (
          <div className="grid gap-6 sm:grid-cols-3">
            <div className="border-rule h-24 border-t pt-3">
              <div className="bg-quiet/15 h-3 w-24 rounded-[2px]" />
            </div>
            <div className="border-rule h-24 border-t pt-3">
              <div className="bg-quiet/15 h-3 w-24 rounded-[2px]" />
            </div>
            <div className="border-rule h-24 border-t pt-3">
              <div className="bg-quiet/15 h-3 w-24 rounded-[2px]" />
            </div>
          </div>
        ) : summary.error ? (
          <ErrorState
            error={summary.error}
            onRetry={summary.reload}
            context="Couldn't load your progress summary."
          />
        ) : summary.data ? (
          <TrajectorySummary data={summary.data} />
        ) : null}
      </div>

      <div className="mt-12">
        {trajectory.loading ? (
          <SpreadSkeleton />
        ) : trajectory.error ? (
          <ErrorState
            error={trajectory.error}
            onRetry={trajectory.reload}
            context="Couldn't load your mastery history."
          />
        ) : !trajectory.data ? null : trajectory.data.historyDays === 0 ? (
          <EmptyState
            title="No history recorded yet"
            body="Mastery history starts at the first sync that moves a score. Nothing has been recorded for these topics yet, so there is no trajectory to draw - only the current values on the Instrument."
            actionHref="/integrations"
            actionLabel="Sync an account"
          />
        ) : !trajectory.data.sufficient ? (
          <EmptyState
            title="Not enough history yet"
            body={`${trajectory.data.historyDays} ${
              trajectory.data.historyDays === 1 ? "day" : "days"
            } recorded so far. Seven are needed before the shape of a line means anything, so none is drawn yet.`}
          />
        ) : (
          <TrajectorySeries data={trajectory.data} />
        )}
      </div>
    </main>
  );
}
