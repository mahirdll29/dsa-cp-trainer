"use client";

import { motion } from "motion/react";
import { DRAW, INSTANT, ROW_STAGGER, useReducedMotion } from "@/lib/motion";

// ---------------------------------------------------------------------------
// PLATE I — THE SPREAD
//
// The one deliberately beautiful object in this app, and it is on /login and
// /register because those are the only two screens with no data of their own.
//
// IT IS NOT A MOCK-UP. Every bar length below is a real mastery score, and the
// thirteen dotted rows are thirteen topics that genuinely have no data —
// measured from the verified Codeforces account (543 UserProblem rows, 19
// topics with evidence). Someone who knows the engine is reading a true
// measurement; everyone else sees an abstract composition. The product proves
// its own claim before the visitor has typed anything.
//
// WHY SVG RATHER THAN AN IMAGE: it inherits the theme's custom properties, so
// the plate flips between the light and dark registers with the rest of the app
// and needs no second asset; it stays crisp at any size; and it costs no
// network request.
//
// THE TWO CALIBRATION MARKS ARE BOTH REAL ENGINE CONSTANTS, not decoration
// borrowed from the look of scientific diagrams:
//
//   NEUTRAL   0.50  — the prior. `mastery = 0.5 + (successRate - 0.5) x
//                     confidence`, so the score is centred here BY
//                     CONSTRUCTION, and a bar has to grow out of it rather
//                     than out of zero. Growing from zero would assert
//                     "fraction of a syllabus completed", which this number is
//                     emphatically not.
//   THRESHOLD 0.60  — WEAK_THRESHOLD in engine/mastery.ts. Everything left of
//                     the dashed line is what the engine calls weak. Drawing it
//                     is what makes the weak/strong split legible instead of
//                     looking like an arbitrary colour choice.
// ---------------------------------------------------------------------------

type Row = { slug: string; score: number; weak: boolean };

// Measured, weakest first. The two "weak" topics score 0.5333 on a PERFECT 2/2
// record — which is the smoothing doing its job: two data points is not enough
// evidence to believe anyone is strong, whatever the record says. That is the
// single most instructive row on the plate.
const MEASURED: Row[] = [
  { slug: "recursion", score: 0.5333, weak: true },
  { slug: "shortest-path", score: 0.5333, weak: true },
  { slug: "hash-table", score: 0.6, weak: false },
  { slug: "trees", score: 0.6, weak: false },
  { slug: "union-find", score: 0.6, weak: false },
  { slug: "graphs", score: 0.68, weak: false },
  { slug: "depth-first-search", score: 0.7667, weak: false },
  { slug: "combinatorics", score: 0.8667, weak: false },
  { slug: "bit-manipulation", score: 0.875, weak: false },
  { slug: "two-pointers", score: 0.8974, weak: false },
  { slug: "binary-search", score: 0.9259, weak: false },
  { slug: "strings", score: 0.931, weak: false },
  { slug: "constructive-algorithms", score: 0.9357, weak: false },
  { slug: "dynamic-programming", score: 0.9403, weak: false },
  { slug: "sorting", score: 0.9474, weak: false },
  { slug: "number-theory", score: 0.9508, weak: false },
  { slug: "greedy", score: 0.9549, weak: false },
  { slug: "simulation", score: 0.9632, weak: false },
  { slug: "math", score: 0.9783, weak: false },
];

// Thirteen topics with no evidence at all. They keep their full row, their full
// width and their place in the sequence — they are not shortened, not faded
// out, and above all not drawn at zero length. A row at zero would say "this
// person is terrible at tries"; the truth is that nobody has ever asked.
const UNMEASURED = [
  "arrays",
  "backtracking",
  "binary-search-tree",
  "breadth-first-search",
  "heap",
  "linked-list",
  "matrix",
  "prefix-sum",
  "queue",
  "segment-tree",
  "sliding-window",
  "stack",
  "trie",
];

// --- geometry, in viewBox units -------------------------------------------
const W = 900;
const H = 1168;
const TRACK_X0 = 300; // score 0.0
const TRACK_X1 = 760; // score 1.0
const LABEL_RIGHT = 286;
const VALUE_RIGHT = 820;
const ROW_PITCH = 22;
const BAR_H = 5;
const FIRST_ROW_Y = 232;

const x = (score: number) => TRACK_X0 + score * (TRACK_X1 - TRACK_X0);
const NEUTRAL_X = x(0.5);
const THRESHOLD_X = x(0.6);

const BREAK_Y = FIRST_ROW_Y + MEASURED.length * ROW_PITCH + 16;
const UNMEASURED_Y = BREAK_Y + 30;
const AXIS_Y = UNMEASURED_Y + UNMEASURED.length * ROW_PITCH + 42;

export function Plate({ className }: { className?: string }) {
  const reduced = useReducedMotion();

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={className}
      role="img"
      aria-labelledby="plate-title plate-desc"
      preserveAspectRatio="xMidYMid meet"
    >
      {/* The alternative text carries the plate's ACTUAL CONTENT, not a
          description of its appearance. A screen-reader user gets the same
          finding a sighted user gets: mostly strong, two thin, thirteen
          untouched. */}
      <title id="plate-title">Plate I — The Spread</title>
      <desc id="plate-desc">
        A measured topic profile. Nineteen of thirty-two topics have evidence and
        are drawn as bars deviating from a neutral line at 0.5; the strongest is
        Math at 0.9783. Two topics, Recursion and Shortest Path, sit below the
        weak threshold of 0.6 despite a perfect record, because two solved
        problems is too little evidence to conclude anything. The remaining
        thirteen topics have no data at all and are drawn as dotted rows with no
        bar and no score.
      </desc>

      {/* Plate frame. One hairline, inset — the convention of a printed plate,
          and it gives the composition an edge to hold against. */}
      <rect
        x={28}
        y={28}
        width={W - 56}
        height={H - 56}
        fill="none"
        stroke="var(--rule)"
        strokeWidth={1}
      />

      {/* ---- header ---- */}
      <text x={80} y={92} className="t-data-xs" fill="var(--quiet)" letterSpacing="0.18em">
        PLATE I
      </text>
      <text
        x={VALUE_RIGHT}
        y={92}
        textAnchor="end"
        className="t-data-xs"
        fill="var(--quiet)"
        letterSpacing="0.18em"
      >
        TOPIC MASTERY
      </text>

      <text x={80} y={140} className="t-display-lg" fill="var(--ink)">
        The Spread
      </text>
      <text x={80} y={168} className="t-data" fill="var(--quiet)">
        one competitor · thirty-two topics · measured, not estimated
      </text>

      <line x1={80} y1={190} x2={VALUE_RIGHT} y2={190} stroke="var(--rule)" strokeWidth={1} />

      {/* ---- the neutral axis: one line, full height of both blocks ----
          Drawn in --quiet rather than --rule because it carries meaning, and a
          meaningful line should not be as faint as a separator. */}
      <line
        x1={NEUTRAL_X}
        y1={FIRST_ROW_Y - 14}
        x2={NEUTRAL_X}
        y2={UNMEASURED_Y + UNMEASURED.length * ROW_PITCH - 4}
        stroke="var(--quiet)"
        strokeWidth={1}
      />

      {/* ---- the weak threshold, 0.60 ---- */}
      <line
        x1={THRESHOLD_X}
        y1={FIRST_ROW_Y - 14}
        x2={THRESHOLD_X}
        y2={FIRST_ROW_Y + MEASURED.length * ROW_PITCH - 4}
        stroke="var(--quiet)"
        strokeWidth={1}
        strokeDasharray="2 4"
        opacity={0.7}
      />
      <text
        x={THRESHOLD_X + 6}
        y={FIRST_ROW_Y - 20}
        className="t-data-xs"
        fill="var(--quiet)"
      >
        0.60 weak
      </text>
      <text x={NEUTRAL_X - 6} y={FIRST_ROW_Y - 20} textAnchor="end" className="t-data-xs" fill="var(--quiet)">
        neutral 0.50
      </text>

      {/* ---- measured rows ---- */}
      {MEASURED.map((row, index) => {
        const y = FIRST_ROW_Y + index * ROW_PITCH;
        const end = x(row.score);
        const left = Math.min(NEUTRAL_X, end);
        const width = Math.abs(end - NEUTRAL_X);
        const color = row.weak ? "var(--deficit)" : "var(--surplus)";

        return (
          <g key={row.slug}>
            <text
              x={LABEL_RIGHT}
              y={y + 4}
              textAnchor="end"
              className="t-data-xs"
              fill="var(--ink)"
            >
              {row.slug}
            </text>

            {/* THE BAR GROWS OUT OF THE AXIS. `originX` is set to whichever end
                touches the neutral line, so a scaleX animation expands away
                from it — the motion itself is the explanation of the axis. */}
            <motion.rect
              x={left}
              y={y - BAR_H / 2}
              width={Math.max(width, 1)}
              height={BAR_H}
              fill={color}
              initial={reduced ? false : { scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={reduced ? INSTANT : { ...DRAW, delay: index * ROW_STAGGER }}
              style={{ originX: end >= NEUTRAL_X ? 0 : 1, originY: 0.5 }}
            />

            <text
              x={VALUE_RIGHT}
              y={y + 4}
              textAnchor="end"
              className="t-data-xs"
              fill="var(--quiet)"
            >
              {row.score.toFixed(4)}
            </text>
          </g>
        );
      })}

      {/* ---- the register change ----
          A labelled break, not a gap. The reader is told the rows below are a
          different KIND of thing before they see one. */}
      <line x1={80} y1={BREAK_Y} x2={VALUE_RIGHT} y2={BREAK_Y} stroke="var(--rule)" strokeWidth={1} />
      <text x={80} y={BREAK_Y + 20} className="t-data-xs" fill="var(--quiet)" letterSpacing="0.18em">
        NO EVIDENCE · 13 TOPICS · NOT SCORED
      </text>

      {/* ---- unmeasured rows ----
          Dotted across the FULL track width rather than a short bar. A short
          mark of any length would be read as a quantity; a graticule is read as
          a place where a measurement could go. */}
      {UNMEASURED.map((slug, index) => {
        const y = UNMEASURED_Y + index * ROW_PITCH;
        return (
          <g key={slug}>
            <text
              x={LABEL_RIGHT}
              y={y + 4}
              textAnchor="end"
              className="t-data-xs"
              fill="var(--quiet)"
            >
              {slug}
            </text>
            <line
              x1={TRACK_X0}
              y1={y}
              x2={TRACK_X1}
              y2={y}
              stroke="var(--quiet)"
              strokeWidth={1}
              strokeDasharray="1 5"
              opacity={0.55}
            />
            {/* An em dash, never a zero. */}
            <text
              x={VALUE_RIGHT}
              y={y + 4}
              textAnchor="end"
              className="t-data-xs"
              fill="var(--quiet)"
            >
              —
            </text>
          </g>
        );
      })}

      {/* ---- calibration ---- */}
      <line x1={TRACK_X0} y1={AXIS_Y} x2={TRACK_X1} y2={AXIS_Y} stroke="var(--rule)" strokeWidth={1} />
      {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
        <g key={tick}>
          <line
            x1={x(tick)}
            y1={AXIS_Y}
            x2={x(tick)}
            y2={AXIS_Y + (tick === 0.5 ? 9 : 5)}
            stroke="var(--quiet)"
            strokeWidth={1}
          />
          <text
            x={x(tick)}
            y={AXIS_Y + 26}
            textAnchor="middle"
            className="t-data-xs"
            fill="var(--quiet)"
          >
            {tick.toFixed(2)}
          </text>
        </g>
      ))}

      {/* MARGINALIA, PLACED INSIDE THE VOID IT DESCRIBES.
          On this profile no topic's evidence falls below neutral, so the whole
          region left of the axis is genuinely empty — that emptiness is the
          finding, not a gap to fill with decoration. The note sits in it, at
          x=310 (clear of the label column, which ends at 286) and at rows whose
          bars are all far to the right, so nothing overlaps. */}
      <text x={324} y={FIRST_ROW_Y + 13 * ROW_PITCH} className="t-data-xs" fill="var(--quiet)">
        nothing on this profile falls
      </text>
      <text x={324} y={FIRST_ROW_Y + 13 * ROW_PITCH + 16} className="t-data-xs" fill="var(--quiet)">
        left of neutral. the weakness
      </text>
      <text x={324} y={FIRST_ROW_Y + 13 * ROW_PITCH + 32} className="t-data-xs" fill="var(--quiet)">
        here is absence, not failure.
      </text>

      {/* ---- specimen line ---- */}
      <text x={80} y={H - 62} className="t-data-xs" fill="var(--quiet)" letterSpacing="0.1em">
        n=32 · MEASURED 19 · UNMEASURED 13 · SOURCE CODEFORCES · 543 SUBMISSIONS RESOLVED
      </text>
    </svg>
  );
}
