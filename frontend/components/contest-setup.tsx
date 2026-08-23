"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { ErrorState, QueueSkeleton } from "@/components/states";
import { useResource } from "@/lib/use-resource";
import type { Contest, ContestOptions, DifficultyBand } from "@/lib/types";

// The setup screen shows what a size actually produces before it is chosen. The spread
// comes off the server with the options: a table copied to the client is a promise the
// selector has not made.

const BANDS: DifficultyBand[] = ["EASY", "MEDIUM", "HARD"];

const BAND_LABEL: Record<DifficultyBand, string> = {
  EASY: "easy",
  MEDIUM: "medium",
  HARD: "hard",
};

function Choice({
  value,
  selected,
  onSelect,
  children,
}: {
  value: number;
  selected: boolean;
  onSelect: (value: number) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(value)}
      className={`t-data rounded-[2px] border px-3 py-1.5 ${
        selected
          ? "border-ink text-ink"
          : "border-rule text-quiet hover:border-quiet/70 hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

export function ContestSetup({
  onStarted,
}: {
  onStarted: (contest: Contest) => void;
}) {
  const options = useResource(() => api<ContestOptions>("/api/contests/options"));

  const [durationMinutes, setDuration] = useState<number | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (options.loading) return <QueueSkeleton label="Loading contest options" />;
  if (options.error) {
    return (
      <ErrorState
        error={options.error}
        onRetry={options.reload}
        context="Couldn't load contest options."
      />
    );
  }
  if (!options.data) return null;

  const { durationMinutes: durations, sizes, spread } = options.data;
  const chosenDuration = durationMinutes ?? durations[0];
  const chosenSize = size ?? sizes[0];
  const chosenSpread = spread[String(chosenSize)];

  async function start() {
    setPending(true);
    setError(null);
    try {
      const result = await api<{ contest: Contest }>("/api/contests", {
        method: "POST",
        body: { durationMinutes: chosenDuration, size: chosenSize },
      });
      onStarted(result.contest);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Couldn't start that contest."
      );
      setPending(false);
    }
  }

  return (
    <section className="panel p-5" aria-labelledby="setup-heading">
      <h2 id="setup-heading" className="t-display">
        New contest
      </h2>
      <p className="t-body-sm text-quiet mt-1 max-w-prose">
        A fixed spread at a fixed length. Nothing you have already solved appears, and
        the clock is the server&apos;s, not this page&apos;s.
      </p>

      <div className="mt-6">
        <p className="t-eyebrow">Duration</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {durations.map((value) => (
            <Choice
              key={value}
              value={value}
              selected={value === chosenDuration}
              onSelect={setDuration}
            >
              {value} min
            </Choice>
          ))}
        </div>
      </div>

      <div className="mt-5">
        <p className="t-eyebrow">Problems</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {sizes.map((value) => (
            <Choice
              key={value}
              value={value}
              selected={value === chosenSize}
              onSelect={setSize}
            >
              {value}
            </Choice>
          ))}
        </div>
      </div>

      {chosenSpread ? (
        <p className="t-data-xs text-quiet mt-4 tracking-[0.1em] uppercase">
          {BANDS.filter((band) => chosenSpread[band] > 0)
            .map((band) => `${chosenSpread[band]} ${BAND_LABEL[band]}`)
            .join(" · ")}
        </p>
      ) : null}

      <div className="border-rule mt-6 border-t pt-5">
        <button
          type="button"
          onClick={() => void start()}
          disabled={pending}
          className="border-quiet/70 t-body-sm hover:bg-surface rounded-[2px] border px-3 py-1.5 disabled:opacity-50"
        >
          {pending ? "Selecting problems…" : "Start contest"}
        </button>
        {pending ? (
          <p className="t-data-xs text-quiet mt-2">
            Sampling the catalog. This takes a few seconds.
          </p>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="t-body-sm text-deficit mt-3">
          {error}
        </p>
      ) : null}
    </section>
  );
}
