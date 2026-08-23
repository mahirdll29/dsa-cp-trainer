"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { bandColorClass, formatClock, providerTag } from "@/lib/format";
import type { Contest } from "@/lib/types";

// The running contest. The countdown here is display only: it is seeded from the
// server's remainingSeconds on every response and never from endsAt measured against a
// browser clock, because the server re-decides on each request and a fast local clock
// would buy nothing but an early rejection.

function letter(position: number): string {
  return String.fromCharCode(64 + position);
}

export function ContestLive({
  contest,
  onFinished,
}: {
  contest: Contest;
  onFinished: (contestId: string) => void;
}) {
  const [remaining, setRemaining] = useState(contest.remainingSeconds);
  const [claimed, setClaimed] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(
      contest.problems.map((entry) => [entry.problem.id, entry.claimedSolvedAt])
    )
  );
  const [busy, setBusy] = useState(false);
  // One in-flight claim per problem. Without this, tapping a toggle twice quickly lets
  // the first response land after the second optimistic update and overwrite it, so the
  // button ends up disagreeing with the row it just wrote.
  const [inFlight, setInFlight] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Re-seeded during render rather than in an effect. An effect runs after paint, so
  // the frame between a refetch landing and the effect firing would show a countdown
  // the server has already superseded.
  const [seededFrom, setSeededFrom] = useState(contest);
  if (contest !== seededFrom) {
    setSeededFrom(contest);
    setRemaining(contest.remainingSeconds);
    setClaimed(
      Object.fromEntries(
        contest.problems.map((entry) => [entry.problem.id, entry.claimedSolvedAt])
      )
    );
  }

  useEffect(() => {
    const timer = setInterval(() => {
      setRemaining((value) => (value > 0 ? value - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const expired = remaining === 0;

  // The server stopped accepting claims at endsAt regardless of this page. Finalizing
  // here only makes the screen agree with what already happened.
  useEffect(() => {
    if (!expired) return;
    let live = true;
    void api(`/api/contests/${contest.id}/finalize`, {
      method: "POST",
      body: { status: "COMPLETED" },
    })
      .catch(() => undefined)
      .then(() => {
        if (live) onFinished(contest.id);
      });
    return () => {
      live = false;
    };
  }, [expired, contest.id, onFinished]);

  async function toggle(problemId: string) {
    const solved = claimed[problemId] === null;
    const previous = claimed[problemId];

    setClaimed((current) => ({
      ...current,
      [problemId]: solved ? new Date().toISOString() : null,
    }));
    setInFlight((current) => [...current, problemId]);
    setError(null);

    try {
      const result = await api<{ claimedSolvedAt: string | null }>(
        `/api/contests/${contest.id}/problems/${problemId}/claim`,
        { method: "POST", body: { solved } }
      );
      // The server's timestamp replaces the optimistic one, so what is displayed is
      // what was actually recorded.
      setClaimed((current) => ({
        ...current,
        [problemId]: result.claimedSolvedAt,
      }));
    } catch (caught) {
      setClaimed((current) => ({ ...current, [problemId]: previous }));
      setError(
        caught instanceof ApiError ? caught.message : "Couldn't record that."
      );
    } finally {
      setInFlight((current) => current.filter((id) => id !== problemId));
    }
  }

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/contests/${contest.id}/finalize`, {
        method: "POST",
        body: { status: "ABANDONED" },
      });
      onFinished(contest.id);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Couldn't end that contest."
      );
      setBusy(false);
    }
  }

  const solvedCount = Object.values(claimed).filter(
    (value) => value !== null
  ).length;

  return (
    <section className="panel p-5" aria-labelledby="contest-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div>
          <p className="t-eyebrow">In contest</p>
          <h2 id="contest-heading" className="t-display mt-1">
            {contest.durationMinutes} minutes · {contest.problems.length} problems
          </h2>
          <p className="t-data-xs text-quiet mt-1">
            {solvedCount} of {contest.problems.length} marked solved
          </p>
        </div>

        <div className="text-right">
          <p className="t-eyebrow">Remaining</p>
          {/* Tabular numerals, so the clock does not jitter as the digits change. */}
          <p className={`t-data-lg mt-1 ${expired ? "text-quiet" : "text-ink"}`}>
            {formatClock(remaining)}
          </p>
        </div>
      </div>

      <ol className="border-rule mt-6 border-t">
        {contest.problems.map((entry) => {
          const isClaimed = claimed[entry.problem.id] !== null;
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

                  {entry.problem.problemTopics.length > 0 ? (
                    <p className="t-data-xs text-quiet mt-1">
                      {entry.problem.problemTopics
                        .map((link) => link.topic.name)
                        .join(" · ")}
                    </p>
                  ) : null}
                </div>

                {/* Absent once the clock stops rather than disabled: a control that can
                    never do anything again is a promise the contest cannot keep. */}
                {expired ? (
                  <span className="t-data-xs text-quiet shrink-0 pt-1">
                    {isClaimed ? "marked solved" : "not marked"}
                  </span>
                ) : (
                  <button
                    type="button"
                    aria-pressed={isClaimed}
                    disabled={inFlight.includes(entry.problem.id)}
                    onClick={() => void toggle(entry.problem.id)}
                    className={`t-body-sm shrink-0 rounded-[2px] border px-3 py-1.5 disabled:opacity-50 ${
                      isClaimed
                        ? "border-surplus text-surplus"
                        : "border-quiet/70 text-quiet hover:bg-surface hover:text-ink"
                    }`}
                  >
                    {isClaimed ? "Solved" : "Mark solved"}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="border-rule mt-6 border-t pt-5">
        {expired ? (
          <p className="t-body-sm text-quiet">
            Time is up. Collecting the result.
          </p>
        ) : (
          <button
            type="button"
            onClick={() => void finish()}
            disabled={busy}
            className="border-quiet/70 t-body-sm text-quiet hover:bg-surface hover:text-ink rounded-[2px] border px-3 py-1.5 disabled:opacity-50"
          >
            {busy ? "Ending…" : "End contest early"}
          </button>
        )}
      </div>

      {error ? (
        <p role="alert" className="t-body-sm text-deficit mt-3">
          {error}
        </p>
      ) : null}
    </section>
  );
}
