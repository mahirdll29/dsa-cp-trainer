"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { api, ApiError } from "@/lib/api";
import { bandColorClass, formatClock, NO_DATA, providerTag } from "@/lib/format";
import { INSTANT, REORDER, TAP, useReducedMotion } from "@/lib/motion";
import type { ActiveSession, HintGate, HintResult } from "@/lib/types";

// The three ceilings are named to the user. A ladder whose rungs are unlabelled
// reads as the same hint three times, and the whole point is that they differ.
const LEVEL_LABEL = ["Orientation", "Technique", "Construction"];

const MAX_LEVEL = 3;

function HintSlot({ level, content }: { level: number; content?: string }) {
  return (
    <li className="border-rule border-b py-4 last:border-b-0">
      <p className="t-data-xs text-quiet tracking-[0.1em] uppercase">
        {level} · {LEVEL_LABEL[level - 1]}
      </p>

      {content === undefined ? (
        // ABSENCE IS RENDERED, NOT OMITTED, and in its own register: a dashed rule
        // and the no-data glyph, never a greyed copy of a hint that does not exist.
        <div className="border-rule mt-2 border-l-2 border-dashed pl-3">
          <span className="t-data text-quiet">{NO_DATA}</span>
        </div>
      ) : (
        <p className="t-body-sm text-ink border-quiet/40 mt-2 max-w-prose border-l-2 pl-3">
          {content}
        </p>
      )}
    </li>
  );
}

export function PracticeSession({
  session,
  onChanged,
}: {
  session: ActiveSession;
  onChanged: () => void;
}) {
  const reduced = useReducedMotion();

  // Seeded from the server on every response and never from a start timestamp read
  // in the browser. The tick below is display only; the server re-decides on each
  // request, so a fast client clock buys nothing but an early re-check.
  const [elapsed, setElapsed] = useState(session.elapsedSeconds);
  const [gate, setGate] = useState<HintGate>(session.gate);
  const [countdown, setCountdown] = useState(
    session.gate.state === "COOLDOWN" ? session.gate.secondsRemaining : 0
  );

  const [pending, setPending] = useState(false);
  // An AI outage is quiet and separate from the gate: it did not change the
  // schedule, so it must not overwrite what the schedule says.
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "SOLVED" | "ABANDONED">(null);
  const [error, setError] = useState<string | null>(null);

  // A refetch produces a new session object, which re-seeds every counter from the
  // server's answer rather than letting the local ones drift across a reload.
  //
  // Done DURING RENDER rather than in an effect. An effect runs after paint, so the
  // frame between a refetch landing and the effect firing shows the old countdown -
  // briefly displaying a number the server has already superseded. React re-renders
  // this component before touching the DOM, so nothing stale is ever painted.
  const [seededFrom, setSeededFrom] = useState(session);
  if (session !== seededFrom) {
    setSeededFrom(session);
    setElapsed(session.elapsedSeconds);
    setGate(session.gate);
    setCountdown(
      session.gate.state === "COOLDOWN" ? session.gate.secondsRemaining : 0
    );
    setUnavailable(null);
  }

  useEffect(() => {
    const timer = setInterval(() => {
      setElapsed((value) => value + 1);
      setCountdown((value) => (value > 0 ? value - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const exhausted = gate.state === "EXHAUSTED";
  const locked = gate.state === "COOLDOWN" && countdown > 0;
  const nextLevel = gate.state === "EXHAUSTED" ? null : gate.level;

  async function askForHint() {
    setPending(true);
    setUnavailable(null);
    try {
      const result = await api<HintResult>(`/api/sessions/${session.id}/hint`, {
        method: "POST",
      });

      if (result.granted) {
        // Refetch rather than splice the hint in: hints, gate and elapsed then all
        // arrive from one place, which is the only way they cannot disagree.
        onChanged();
        return;
      }

      if (result.reason === "COOLDOWN") {
        setGate({
          state: "COOLDOWN",
          level: result.nextLevel,
          secondsRemaining: result.secondsRemaining,
          message: result.message,
        });
        setCountdown(result.secondsRemaining);
      } else if (result.reason === "EXHAUSTED") {
        setGate({ state: "EXHAUSTED", message: result.message });
      } else {
        setUnavailable(result.message);
      }
    } catch (caught) {
      setUnavailable(
        caught instanceof ApiError
          ? caught.message
          : "Couldn't reach the server. Your clock is untouched."
      );
    } finally {
      setPending(false);
    }
  }

  async function resolve(status: "SOLVED" | "ABANDONED") {
    setBusy(status);
    setError(null);
    try {
      await api(`/api/sessions/${session.id}/resolve`, {
        method: "POST",
        body: { status },
      });
      onChanged();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Couldn't end that session."
      );
      setBusy(null);
    }
  }

  const topics = session.problem.problemTopics.map((link) => link.topic.name);

  return (
    <section className="panel p-5" aria-labelledby="session-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <p className="t-eyebrow">In session</p>
          <h2 id="session-heading" className="t-display mt-1 min-w-0">
            <a
              href={session.problem.url}
              target="_blank"
              rel="noreferrer"
              className="hover:underline hover:underline-offset-4"
            >
              {session.problem.title}
              <span className="sr-only">
                {" "}
                (opens on {session.problem.provider})
              </span>
            </a>
          </h2>
          <p className="t-data-xs mt-1 flex flex-wrap items-center gap-2">
            <span className="text-quiet">
              {providerTag(session.problem.provider)}
            </span>
            <span className={bandColorClass(session.problem.difficultyBand)}>
              {session.problem.difficultyRaw}
            </span>
            {topics.length > 0 ? (
              <span className="text-quiet">{topics.join(" · ")}</span>
            ) : null}
          </p>
        </div>

        <div className="text-right">
          <p className="t-eyebrow">Elapsed</p>
          <p className="t-data-lg mt-1">{formatClock(elapsed)}</p>
        </div>
      </div>

      <ol className="border-rule mt-6 border-t">
        {Array.from({ length: MAX_LEVEL }).map((_, index) => {
          const issued = session.hints.find((hint) => hint.level === index + 1);
          return (
            <motion.div key={index} layout transition={reduced ? INSTANT : REORDER}>
              <HintSlot level={index + 1} content={issued?.content} />
            </motion.div>
          );
        })}
      </ol>

      <div className="mt-5">
        {/* ABSENT, not disabled, once all three are out. A button that can never
            do anything again is a promise the session cannot keep. */}
        {exhausted ? (
          <p className="t-body-sm text-quiet">{gate.message}</p>
        ) : (
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
            <motion.button
              type="button"
              onClick={() => void askForHint()}
              disabled={pending || locked}
              whileTap={reduced || locked ? undefined : { scale: 0.98 }}
              transition={reduced ? INSTANT : TAP}
              className="border-quiet/70 t-body-sm hover:bg-surface rounded-[2px] border px-3 py-1.5 disabled:opacity-50"
            >
              {pending
                ? "Asking…"
                : nextLevel !== null
                  ? `Hint ${nextLevel} · ${LEVEL_LABEL[nextLevel - 1]}`
                  : "Hint"}
            </motion.button>

            {locked ? (
              <span className="t-data text-quiet">
                unlocks in {formatClock(countdown)}
              </span>
            ) : null}
          </div>
        )}

        {/* The fixed nudge, and never the countdown a second time. */}
        {locked && gate.state === "COOLDOWN" ? (
          <p className="t-body-sm text-quiet mt-2 max-w-prose">{gate.message}</p>
        ) : null}

        {/* An AI outage is quiet: it is a missing sentence, not a broken page, and
            it cost the user nothing. */}
        {unavailable ? (
          <p role="status" className="t-body-sm text-quiet mt-2 max-w-prose">
            {unavailable}
          </p>
        ) : null}
      </div>

      <div className="border-rule mt-6 flex flex-wrap gap-2 border-t pt-5">
        <button
          type="button"
          onClick={() => void resolve("SOLVED")}
          disabled={busy !== null}
          className="border-quiet/70 t-body-sm hover:bg-surface rounded-[2px] border px-3 py-1.5 disabled:opacity-50"
        >
          {busy === "SOLVED" ? "Saving…" : "Solved it"}
        </button>
        <button
          type="button"
          onClick={() => void resolve("ABANDONED")}
          disabled={busy !== null}
          className="border-quiet/70 t-body-sm text-quiet hover:bg-surface hover:text-ink rounded-[2px] border px-3 py-1.5 disabled:opacity-50"
        >
          {busy === "ABANDONED" ? "Saving…" : "Gave up"}
        </button>
      </div>

      {/* A failed resolve IS loud: unlike a hint, it is the user's own record of
          what happened, and silently losing it would be a lie. */}
      {error ? (
        <p role="alert" className="t-body-sm text-deficit mt-3">
          {error}
        </p>
      ) : null}
    </section>
  );
}
