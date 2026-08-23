"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { ErrorState, SessionSkeleton } from "@/components/states";
import {
  absoluteTime,
  bandColorClass,
  formatDuration,
  NO_DATA,
  providerTag,
} from "@/lib/format";
import { useResource } from "@/lib/use-resource";
import type { Contest, ContestEntry, ReconcileResult } from "@/lib/types";

// What the user claimed and what the providers confirmed, kept visibly separate. They
// are two different facts, and a screen that merged them would be asserting a
// verification that has not happened - reconciliation is a manual step because a sync
// takes tens of seconds.

function letter(position: number): string {
  return String.fromCharCode(64 + position);
}

// Before reconciliation there is nothing to say about confirmation, so the column reads
// as absent rather than as a negative result.
function outcome(entry: ContestEntry, reconciled: boolean) {
  if (entry.confirmedSolvedAt !== null) {
    return { label: "confirmed", className: "text-surplus" };
  }
  if (entry.claimedSolvedAt !== null) {
    return reconciled
      ? { label: "claimed, not found", className: "text-median" }
      : { label: "claimed", className: "text-ink" };
  }
  return { label: NO_DATA, className: "text-quiet" };
}

export function ContestResults({
  contestId,
  onBack,
}: {
  contestId: string;
  onBack: () => void;
}) {
  const [version, setVersion] = useState(0);
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const resource = useResource(
    () => api<{ contest: Contest }>(`/api/contests/${contestId}`),
    version
  );

  async function reconcile() {
    setChecking(true);
    setNote(null);
    try {
      const result = await api<ReconcileResult>(
        `/api/contests/${contestId}/reconcile`,
        { method: "POST" }
      );
      setNote(
        result.syncSkipped
          ? "A sync was already running, so nothing was re-checked. Try again in a moment."
          : `Checked. ${result.confirmed} of ${result.contest.problems.length} confirmed.`
      );
      setVersion((value) => value + 1);
    } catch (caught) {
      setNote(
        caught instanceof ApiError ? caught.message : "Couldn't check your solves."
      );
    } finally {
      setChecking(false);
    }
  }

  if (resource.loading) return <SessionSkeleton />;
  if (resource.error) {
    return (
      <ErrorState
        error={resource.error}
        onRetry={resource.reload}
        context="Couldn't load that contest."
      />
    );
  }
  if (!resource.data) return null;

  const contest = resource.data.contest;
  const reconciled = contest.reconciledAt !== null;
  const claimed = contest.problems.filter((e) => e.claimedSolvedAt !== null).length;
  const confirmed = contest.problems.filter(
    (e) => e.confirmedSolvedAt !== null
  ).length;

  return (
    <section className="panel p-5" aria-labelledby="results-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div>
          <p className="t-eyebrow">
            {contest.status === "ABANDONED" ? "Ended early" : "Finished"}
          </p>
          <h2 id="results-heading" className="t-display mt-1">
            {contest.durationMinutes} minutes · {contest.problems.length} problems
          </h2>
          <p className="t-data-xs text-quiet mt-1">
            {absoluteTime(contest.startedAt)}
            {contest.finalizedAt
              ? ` · ran ${formatDuration(contest.startedAt, contest.finalizedAt)}`
              : ""}
          </p>
        </div>

        <div className="text-right">
          <p className="t-eyebrow">{reconciled ? "Confirmed" : "Marked solved"}</p>
          <p className="t-data-lg mt-1">
            {reconciled ? confirmed : claimed} / {contest.problems.length}
          </p>
        </div>
      </div>

      {/* Null reconciledAt is not "nothing was confirmed" - it is "nobody has looked
          yet", and the two must not render the same way. */}
      {!reconciled ? (
        <div className="border-rule mt-5 rounded-[2px] border border-dashed p-4">
          <p className="t-body-sm text-ink font-medium">Self-reported so far</p>
          <p className="t-body-sm text-quiet mt-1 max-w-prose">
            These are your own marks. Checking them against Codeforces and LeetCode
            needs a full sync, which takes up to a minute, so it does not run
            automatically when a contest ends.
          </p>
          <button
            type="button"
            onClick={() => void reconcile()}
            disabled={checking}
            className="border-quiet/70 t-body-sm hover:bg-surface mt-3 rounded-[2px] border px-3 py-1.5 disabled:opacity-50"
          >
            {checking ? "Checking…" : "Check my solves"}
          </button>
        </div>
      ) : (
        <p className="t-data-xs text-quiet mt-4 tracking-[0.1em] uppercase">
          Checked {absoluteTime(contest.reconciledAt)} · claimed {claimed} ·
          confirmed {confirmed}
        </p>
      )}

      {note ? (
        <p role="status" className="t-body-sm text-quiet mt-3">
          {note}
        </p>
      ) : null}

      <ol className="border-rule mt-6 border-t">
        {contest.problems.map((entry) => {
          const state = outcome(entry, reconciled);
          return (
            <li
              key={entry.problem.id}
              className="border-rule border-b last:border-b-0"
            >
              <div className="flex flex-wrap items-start gap-x-4 gap-y-2 py-4">
                <span className="t-data-xs text-quiet w-5 shrink-0 pt-1">
                  {letter(entry.position)}
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <h3 className="t-body-sm min-w-0 font-medium">
                      <a
                        href={entry.problem.url}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:underline hover:underline-offset-4"
                      >
                        {entry.problem.title}
                        <span className="sr-only">
                          {" "}
                          (opens on {entry.problem.provider})
                        </span>
                      </a>
                    </h3>
                    <span className="t-data-xs flex shrink-0 items-center gap-2">
                      <span className="text-quiet">
                        {providerTag(entry.problem.provider)}
                      </span>
                      <span className={bandColorClass(entry.problem.difficultyBand)}>
                        {entry.problem.difficultyRaw}
                      </span>
                    </span>
                  </div>

                  <p className="t-data-xs text-quiet mt-1">
                    {entry.claimedSolvedAt
                      ? `marked at ${formatDuration(contest.startedAt, entry.claimedSolvedAt)}`
                      : "never marked"}
                    {entry.confirmedSolvedAt
                      ? ` · accepted ${absoluteTime(entry.confirmedSolvedAt)}`
                      : ""}
                  </p>
                </div>

                <span
                  className={`t-data-xs w-32 shrink-0 pt-1 text-right ${state.className}`}
                >
                  {state.label}
                </span>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="border-rule mt-6 border-t pt-5">
        <button
          type="button"
          onClick={onBack}
          className="t-body-sm text-ink underline underline-offset-4 hover:no-underline"
        >
          Back to contests
        </button>
      </div>
    </section>
  );
}
