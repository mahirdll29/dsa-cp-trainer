"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { AiAffordance } from "@/components/explain";
import { EmptyState, ErrorState, QueueSkeleton } from "@/components/states";
import { api, ApiError } from "@/lib/api";
import {
  bandColorClass,
  overdueBucket,
  overdueLabel,
  providerTag,
  urgencyColorClass,
} from "@/lib/format";
import { REORDER } from "@/lib/motion";
import type { RevisionItem } from "@/lib/types";
import { useResource } from "@/lib/use-resource";

// ---------------------------------------------------------------------------
// DUE FOR REVIEW — the spaced-repetition queue.
//
// "Due" means dueAt <= now, and the backend returns ONLY those. Items scheduled
// for the future are absent rather than present-and-greyed-out, which is a
// deliberate property of the planner: a list that shows everything is a list
// people stop reading. So this page is never a backlog, it is a session.
//
// The interval ladder is 1, 3, 7, 14, 30 days, fixed for every problem and
// every user. Real SM-2 would adapt each interval from a self-rated recall
// score — we do not collect one, and inventing it from attempt count would be
// fiction dressed as an algorithm. Showing `rep n · Nd` is how the ladder stays
// honest and visible instead of feeling arbitrary.
// ---------------------------------------------------------------------------

function RevisionRow({
  item,
  onReviewed,
}: {
  item: RevisionItem;
  onReviewed: (problemId: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const urgency = overdueBucket(item.dueAt);
  const topics = item.problem.problemTopics.map((link) => link.topic.name);

  async function markReviewed() {
    setPending(true);
    setError(null);
    try {
      await api(`/api/revision/${item.problemId}/review`, { method: "POST" });
      // The item is no longer due — the backend advanced it up the ladder and
      // pushed dueAt into the future — so it leaves the list. Removing it
      // locally rather than refetching is not an optimisation for its own sake:
      // GET /api/revision/due would return the same list minus this row, and
      // paying a round trip to be told something we already know would also
      // reset the scroll position mid-session.
      onReviewed(item.problemId);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Couldn't save that review."
      );
      setPending(false);
    }
  }

  return (
    <motion.li layout transition={REORDER} className="border-rule border-b last:border-b-0">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2 py-4">
        {/* HOW LATE, NOT JUST THAT IT IS LATE. Twelve days past the window is a
            different situation from today, and the spacing effect is the reason
            it matters. Colour reinforces the label; it never replaces it. */}
        <span
          className={`t-data-xs w-24 shrink-0 pt-1 text-right ${urgencyColorClass(urgency)}`}
        >
          {overdueLabel(item.dueAt)}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h3 className="t-body min-w-0 font-medium">
              <a
                href={item.problem.url}
                target="_blank"
                rel="noreferrer"
                className="hover:underline hover:underline-offset-4"
              >
                {item.problem.title}
                <span className="sr-only"> (opens on {item.problem.provider})</span>
              </a>
            </h3>
            <span className="t-data-xs flex shrink-0 items-center gap-2">
              <span className="text-quiet">{providerTag(item.problem.provider)}</span>
              <span className={bandColorClass(item.problem.difficultyBand)}>
                {item.problem.difficultyRaw}
              </span>
            </span>
          </div>

          <p className="t-data-xs text-quiet mt-1">
            rep {item.repetitionCount} · {item.intervalDays}d interval
            {topics.length > 0 ? ` · ${topics.join(" · ")}` : ""}
          </p>

          {/* HINT, NOT EXPLAIN. /api/ai/explain 404s for anything outside the
              caller's current twelve recommendations, and a revision item is
              usually not among them — so Explain here would be a button whose
              brokenness depends on data. /api/ai/hint works on any problem. */}
          <AiAffordance problemId={item.problemId} variant="hint" />

          {error ? (
            <p role="alert" className="t-body-sm text-deficit mt-2">
              {error}
            </p>
          ) : null}
        </div>

        <button
          type="button"
          onClick={() => void markReviewed()}
          disabled={pending}
          className="border-quiet/70 t-body-sm hover:bg-surface shrink-0 rounded-[2px] border px-3 py-1.5 disabled:opacity-50"
        >
          {/* Same verb through the whole action: Mark reviewed -> Saving -> the
              row leaves the list, which is the result. */}
          {pending ? "Saving…" : "Mark reviewed"}
        </button>
      </div>
    </motion.li>
  );
}

export default function RevisionPage() {
  const revision = useResource(() => api<{ items: RevisionItem[] }>("/api/revision/due"));

  const items = revision.data?.items ?? [];

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-6">
      <h1 className="t-display">Due for review</h1>
      <p className="t-body-sm text-quiet mt-1 max-w-prose">
        Reviewing beats new material. Something about to be forgotten is worth
        more than something never learned.
      </p>
      <p className="t-data-xs text-quiet mt-3 tracking-[0.1em] uppercase">
        {items.length} due now
      </p>

      <div className="mt-6">
        {revision.loading ? (
          <QueueSkeleton />
        ) : revision.error ? (
          <ErrorState
            error={revision.error}
            onRetry={revision.reload}
            context="Couldn't load your revision queue."
          />
        ) : items.length === 0 ? (
          // NOTHING DUE IS A GOOD OUTCOME, not an empty shelf, and the copy says
          // so. It also explains where items come from, because a user who has
          // never synced would otherwise read this as the feature being broken.
          <EmptyState
            title="Nothing due today."
            body="Revision items are created when you solve something, and come back on a 1, 3, 7, 14, then 30 day ladder. Solve a few problems and they will show up here."
            actionHref="/"
            actionLabel="See what to solve"
          />
        ) : (
          <ol className="border-rule border-t">
            {items.map((item) => (
              <RevisionRow
                key={item.id}
                item={item}
                onReviewed={(problemId) =>
                  revision.set((current) =>
                    current
                      ? {
                          items: current.items.filter(
                            (row) => row.problemId !== problemId
                          ),
                        }
                      : current
                  )
                }
              />
            ))}
          </ol>
        )}
      </div>
    </main>
  );
}
