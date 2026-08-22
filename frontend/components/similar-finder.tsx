"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { FormField } from "@/components/form-field";
import { EmptyState, ErrorState, QueueSkeleton } from "@/components/states";
import { bandColorClass, providerTag } from "@/lib/format";
import type { DifficultyBand, SimilarResult, SimilarResponse } from "@/lib/types";

const BANDS: DifficultyBand[] = ["EASY", "MEDIUM", "HARD"];

const BAND_LABEL: Record<DifficultyBand, string> = {
  EASY: "Easy",
  MEDIUM: "Medium",
  HARD: "Hard",
};

// 400, 404 and 422 are answers about the link, not failures of the system, so they
// render in the quiet register. Only an unexpected status gets the loud one - the same
// split practice-session.tsx draws between an unavailable hint and a failed resolve.
const REFUSED_STATUSES = [400, 404, 422];

type State =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "refused"; status: number; message: string }
  | { kind: "failed"; error: Error }
  | { kind: "loaded"; data: SimilarResponse };

function ResultRow({ result, rank }: { result: SimilarResult; rank: number }) {
  const shared = new Set(result.sharedTopics);
  const others = result.topics.filter((topic) => !shared.has(topic));

  return (
    <li className="border-rule border-b last:border-b-0">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2 py-4">
        {/* The overlap sits in the gutter where the rank number sits in the queue,
            because here the score IS the rank and printing both says it twice.
            ONE DECIMAL, not zero: 0.5125, 0.5121 and 0.5088 are three different scores
            and rounding them all to "51%" would leave the order looking arbitrary.
            The engine's auditability is the point - a rank you cannot read is noise. */}
        <span className="t-data-xs text-ink w-12 shrink-0 pt-1 text-right">
          <span className="sr-only">Rank {rank}, </span>
          {(result.score * 100).toFixed(1)}%
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h3 className="t-body-sm min-w-0 font-medium">
              <a
                href={result.url}
                target="_blank"
                rel="noreferrer"
                className="hover:underline hover:underline-offset-4"
              >
                {result.title}
                <span className="sr-only"> (opens on {result.provider})</span>
              </a>
            </h3>

            <span className="t-data-xs flex shrink-0 items-center gap-2">
              {/* The word is always printed beside the colour. */}
              {result.solved ? <span className="text-surplus">solved</span> : null}
              <span className="text-quiet">{providerTag(result.provider)}</span>
              <span className={bandColorClass(result.difficultyBand)}>
                {result.difficultyRaw}
              </span>
            </span>
          </div>

          <p className="t-data-xs text-quiet mt-1">
            <span className="sr-only">Shared topics: </span>
            <span className="text-ink">{result.sharedTopics.join(" · ")}</span>
            {others.length > 0 ? (
              <>
                <span className="sr-only">. Also tagged: </span>
                {" · "}
                {others.join(" · ")}
              </>
            ) : null}
          </p>
        </div>
      </div>
    </li>
  );
}

function SourceCard({ source, bands }: { source: SimilarResponse["source"]; bands: DifficultyBand[] }) {
  return (
    <div className="panel p-5">
      <p className="t-eyebrow">Matched against</p>

      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="t-body min-w-0 font-medium">
          <a
            href={source.url}
            target="_blank"
            rel="noreferrer"
            className="hover:underline hover:underline-offset-4"
          >
            {source.title}
            <span className="sr-only"> (opens on {source.provider})</span>
          </a>
        </h2>
        <span className="t-data-xs flex shrink-0 items-center gap-2">
          <span className="text-quiet">{providerTag(source.provider)}</span>
          <span className={bandColorClass(source.difficultyBand)}>
            {source.difficultyRaw}
          </span>
        </span>
      </div>

      <p className="t-data-xs text-quiet mt-2">{source.topics.join(" · ")}</p>

      {/* The one screen in this app that shows a band. The control above operates in
          band space, so hiding the source's band would leave an override to guesswork. */}
      <p className="t-data-xs text-quiet mt-3 tracking-[0.1em] uppercase">
        Band {BAND_LABEL[source.difficultyBand]} · showing{" "}
        {bands.map((band) => BAND_LABEL[band]).join(", ")}
      </p>
    </div>
  );
}

function Refusal({ status, message }: { status: number; message: string }) {
  if (status === 404) {
    return (
      <EmptyState
        title="Not in the catalog."
        body={`${message}. Only imported problems can be matched, and the catalogs are synced separately from your own solve history.`}
        actionHref="/integrations"
        actionLabel="Check your linked accounts"
      />
    );
  }

  if (status === 422) {
    return (
      <EmptyState
        title="No topics recorded."
        body={`${message}. Matching is topic overlap and nothing else, so a problem carrying no tags has nothing to match on.`}
      />
    );
  }

  return (
    <EmptyState
      title="That is not a problem link."
      body={`${message}. A link looks like codeforces.com/problemset/problem/1234/A or leetcode.com/problems/two-sum.`}
    />
  );
}

export function SimilarFinder() {
  const [url, setUrl] = useState("");
  const [bands, setBands] = useState<DifficultyBand[]>([]);
  const [state, setState] = useState<State>({ kind: "idle" });

  function toggleBand(band: DifficultyBand) {
    setBands((current) =>
      current.includes(band)
        ? current.filter((value) => value !== band)
        : BANDS.filter((value) => value === band || current.includes(value))
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (url.trim() === "") return;

    setState({ kind: "pending" });

    const params = new URLSearchParams({ url: url.trim() });
    if (bands.length > 0) params.set("bands", bands.join(","));

    try {
      const data = await api<SimilarResponse>(`/api/problems/similar?${params}`);
      setState({ kind: "loaded", data });
    } catch (caught) {
      if (caught instanceof ApiError && REFUSED_STATUSES.includes(caught.status)) {
        setState({ kind: "refused", status: caught.status, message: caught.message });
        return;
      }
      setState({
        kind: "failed",
        error: caught instanceof Error ? caught : new Error("Request failed"),
      });
    }
  }

  return (
    <>
      <form onSubmit={submit} className="grid gap-4">
        <FormField
          id="problem-url"
          label="Problem link"
          value={url}
          onChange={setUrl}
          disabled={state.kind === "pending"}
          hint="A Codeforces or LeetCode problem URL, pasted as it is."
        />

        <fieldset className="grid gap-1.5">
          <legend className="t-body-sm font-medium">Difficulty</legend>
          <p className="t-body-sm text-quiet">
            {bands.length === 0
              ? "Same band as the source problem."
              : `Only ${bands.map((band) => BAND_LABEL[band]).join(", ")}.`}
          </p>
          <div className="mt-1 flex flex-wrap gap-4">
            {BANDS.map((band) => (
              <label key={band} className="t-body-sm flex items-center gap-2">
                {/* A default checkbox renders as a filled white square, which would be
                    the loudest thing on a page whose whole palette is reserved for
                    data. Drawn instead as the same hairline square the panels use,
                    filling with ink when it is on. */}
                <input
                  type="checkbox"
                  checked={bands.includes(band)}
                  onChange={() => toggleBand(band)}
                  disabled={state.kind === "pending"}
                  className="border-quiet/70 checked:bg-ink checked:border-ink focus-visible:outline-ink size-3.5 appearance-none rounded-[2px] border bg-transparent focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
                />
                {BAND_LABEL[band]}
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <button
            type="submit"
            disabled={state.kind === "pending" || url.trim() === ""}
            className="border-quiet/70 t-body-sm hover:bg-surface rounded-[2px] border px-3 py-1.5 disabled:opacity-50"
          >
            {state.kind === "pending" ? "Matching…" : "Find similar"}
          </button>
        </div>
      </form>

      <div className="mt-8">
        {state.kind === "idle" ? (
          <EmptyState
            title="Nothing matched yet."
            body="Paste a problem you have just worked through. Matching is topic overlap weighted by how rare each shared topic is - no model is asked what looks similar."
          />
        ) : state.kind === "pending" ? (
          <QueueSkeleton label="Matching against the catalog" />
        ) : state.kind === "failed" ? (
          <ErrorState
            error={state.error}
            context="Couldn't match that problem."
          />
        ) : state.kind === "refused" ? (
          <Refusal status={state.status} message={state.message} />
        ) : (
          <>
            <SourceCard source={state.data.source} bands={state.data.bands} />

            <div className="mt-8">
              {state.data.results.length === 0 ? (
                <EmptyState
                  title="No matches in that band."
                  body="Nothing else in the selected difficulty shares a topic with this problem. Widen the difficulty and try again."
                />
              ) : (
                <>
                  <p className="t-data-xs text-quiet tracking-[0.1em] uppercase">
                    {state.data.results.length} problem
                    {state.data.results.length === 1 ? "" : "s"} · most overlap first
                  </p>
                  <ol className="border-rule mt-4 border-t">
                    {state.data.results.map((result, index) => (
                      <ResultRow
                        key={result.problemId}
                        result={result}
                        rank={index + 1}
                      />
                    ))}
                  </ol>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
