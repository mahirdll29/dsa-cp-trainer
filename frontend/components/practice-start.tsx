"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { EmptyState, ErrorState, QueueSkeleton } from "@/components/states";
import { bandColorClass, overdueLabel, providerTag } from "@/lib/format";
import type {
  DifficultyBand,
  Provider,
  Recommendation,
  RevisionItem,
} from "@/lib/types";
import { useResource } from "@/lib/use-resource";

// Sessions start from the queues that already exist. There is no paste-a-URL box:
// that needs catalog lookup this app does not have yet, and inventing a lookup here
// would be Module 10 arriving early and badly.

// The two queues return different shapes, so they are flattened to one row for
// display. Nothing is decided here - the order is still each endpoint's own.
type StartRow = {
  problemId: string;
  title: string;
  url: string;
  provider: Provider;
  difficultyRaw: string;
  difficultyBand: DifficultyBand;
  topics: string[];
  note: string;
};

function StartRow({
  row,
  onStarted,
}: {
  row: StartRow;
  onStarted: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setPending(true);
    setError(null);
    try {
      await api("/api/sessions", {
        method: "POST",
        body: { problemId: row.problemId },
      });
      onStarted();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Couldn't start that session."
      );
      setPending(false);
    }
  }

  return (
    <li className="border-rule border-b last:border-b-0">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h3 className="t-body-sm min-w-0 font-medium">
              <a
                href={row.url}
                target="_blank"
                rel="noreferrer"
                className="hover:underline hover:underline-offset-4"
              >
                {row.title}
                <span className="sr-only"> (opens on {row.provider})</span>
              </a>
            </h3>
            <span className="t-data-xs flex shrink-0 items-center gap-2">
              <span className="text-quiet">{providerTag(row.provider)}</span>
              <span className={bandColorClass(row.difficultyBand)}>
                {row.difficultyRaw}
              </span>
            </span>
          </div>

          <p className="t-body-sm text-ink mt-1">{row.note}</p>

          {row.topics.length > 0 ? (
            <p className="t-data-xs text-quiet mt-1">{row.topics.join(" · ")}</p>
          ) : null}

          {error ? (
            <p role="alert" className="t-body-sm text-deficit mt-2">
              {error}
            </p>
          ) : null}
        </div>

        <button
          type="button"
          onClick={() => void start()}
          disabled={pending}
          className="border-quiet/70 t-body-sm hover:bg-surface shrink-0 rounded-[2px] border px-3 py-1.5 disabled:opacity-50"
        >
          {pending ? "Starting…" : "Start"}
        </button>
      </div>
    </li>
  );
}

function StartList({
  heading,
  blurb,
  rows,
  loading,
  error,
  onRetry,
  emptyTitle,
  emptyBody,
  onStarted,
}: {
  heading: string;
  blurb: string;
  rows: StartRow[];
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  emptyTitle: string;
  emptyBody: string;
  onStarted: () => void;
}) {
  return (
    <section className="mt-8">
      <h2 className="t-display">{heading}</h2>
      <p className="t-body-sm text-quiet mt-1 max-w-prose">{blurb}</p>

      <div className="mt-4">
        {loading ? (
          <QueueSkeleton label={`Loading ${heading.toLowerCase()}`} />
        ) : error ? (
          <ErrorState error={error} onRetry={onRetry} context={`Couldn't load ${heading.toLowerCase()}.`} />
        ) : rows.length === 0 ? (
          <EmptyState title={emptyTitle} body={emptyBody} />
        ) : (
          <ol className="border-rule border-t">
            {rows.map((row) => (
              <StartRow key={row.problemId} row={row} onStarted={onStarted} />
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

export function PracticeStart({ onStarted }: { onStarted: () => void }) {
  // Two separate reads so the fast one paints first: /api/revision/due is a plain
  // indexed lookup, while /api/recommendations runs the whole pipeline and measures
  // several seconds.
  const revision = useResource(() =>
    api<{ items: RevisionItem[] }>("/api/revision/due")
  );
  const recommendations = useResource(() =>
    api<{ recommendations: Recommendation[] }>("/api/recommendations")
  );

  const revisionRows: StartRow[] = (revision.data?.items ?? []).map((item) => ({
    problemId: item.problemId,
    title: item.problem.title,
    url: item.problem.url,
    provider: item.problem.provider,
    difficultyRaw: item.problem.difficultyRaw,
    difficultyBand: item.problem.difficultyBand,
    topics: item.problem.problemTopics.map((link) => link.topic.name),
    note: overdueLabel(item.dueAt),
  }));

  const recommendationRows: StartRow[] = (
    recommendations.data?.recommendations ?? []
  ).map((item) => ({
    problemId: item.problemId,
    title: item.title,
    url: item.url,
    provider: item.provider,
    difficultyRaw: item.difficultyRaw,
    difficultyBand: item.difficultyBand,
    topics: item.topics,
    note: item.reason,
  }));

  return (
    <>
      <StartList
        heading="Due for review"
        blurb="Reviewing beats new material. Start here when something is already due."
        rows={revisionRows}
        loading={revision.loading}
        error={revision.error}
        onRetry={revision.reload}
        emptyTitle="Nothing due today."
        emptyBody="Revision items appear once you have solved something and the spacing ladder brings it back around."
        onStarted={onStarted}
      />

      <StartList
        heading="The Queue"
        blurb="Ranked by the engine. The same history always produces the same list."
        rows={recommendationRows}
        loading={recommendations.loading}
        error={recommendations.error}
        onRetry={recommendations.reload}
        emptyTitle="No recommendations yet."
        emptyBody="The engine builds this from your solve history. Link an account and run a sync, and it will fill in."
        onStarted={onStarted}
      />
    </>
  );
}
