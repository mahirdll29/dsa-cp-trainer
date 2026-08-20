"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { formatEvidence, formatScore, NO_DATA } from "@/lib/format";
import { DRAW, INSTANT, ROW_STAGGER, useReducedMotion } from "@/lib/motion";
import type { MasteryOverview, TopicMasteryView, UnknownTopicView } from "@/lib/types";

// The signature element: all 32 topics at once, weakest first, each drawn as a
// deviation from a neutral axis. Everything here follows from one fact about the
// number it renders - mastery is centred on 0.5 by construction, a
// confidence-weighted BELIEF rather than a fraction of anything completed.
//
// So bars grow OUT OF A CENTRE LINE, never from the left edge. A left-anchored bar
// would silently assert "x% of the way through this topic", a claim this number does
// not make, and would render thin evidence as "small" when thin evidence actually
// means "close to neutral".
//
// Unknown topics are a separate table with a dotted graticule and an em dash in every
// numeric column. No code path here can render one at zero, because UnknownTopicView
// has no score field to read.

const WEAK_THRESHOLD = 0.6; // engine/mastery.ts — mirrored for display only

// Fires once for the life of the tab: navigating away and back does not replay it,
// because nothing has been introduced a second time. Module-level so it survives
// unmount.
let hasIntroduced = false;

function Header({ overview }: { overview: MasteryOverview }) {
  return (
    <div className="mb-4">
      <h2 className="t-display">The Spread</h2>
      {/* The sentence that prevents the one misreading this screen invites.
          Without it, a topic at 0.53 with a perfect 2/2 record looks like a
          failure; with it, the reader knows thin evidence lives near the
          middle whatever the record says. */}
      <p className="t-body-sm text-quiet mt-1">
        Confidence-weighted belief, not progress. Thin evidence sits near 0.5
        whatever the record.
      </p>
      <p className="t-data-xs text-quiet mt-3 tracking-[0.1em] uppercase">
        n={overview.weak.length + overview.strong.length + overview.unknown.length} · weak{" "}
        {overview.weak.length} · strong {overview.strong.length} · no data{" "}
        {overview.unknown.length}
      </p>
    </div>
  );
}

// COLUMN WIDTHS ARE DECLARED ONCE AND SHARED by both tables and the tick scale. Not
// tidiness - it is the only way the scale can be true: a browser sizes an `auto`
// table's columns from its content, so each table would pick a different track width
// and the "0.5" label would stop sitting under the axis it labels. table-fixed plus
// this colgroup is what makes the percentages authoritative.
//
// Four columns, not five: targetBand was cut because at five the track collapsed to
// ~150px and the bars stopped reading as measurements. The Queue states the same
// thing far more concretely by naming an actual problem at an actual rating.
const COL_LABEL = "30%";
const COL_TRACK = "44%";

function Columns() {
  return (
    <colgroup>
      <col style={{ width: COL_LABEL }} />
      <col style={{ width: COL_TRACK }} />
      <col style={{ width: "14%" }} />
      <col style={{ width: "12%" }} />
    </colgroup>
  );
}

function MeasuredRow({
  topic,
  index,
  animate,
}: {
  topic: TopicMasteryView;
  index: number;
  animate: boolean;
}) {
  const reduced = useReducedMotion();
  const weak = topic.masteryScore < WEAK_THRESHOLD;

  // Percentages of the track, so the bars stay aligned with the calibration below.
  const scorePct = topic.masteryScore * 100;
  const left = Math.min(50, scorePct);
  const width = Math.abs(scorePct - 50);

  return (
    <tr className="hover:bg-paper/60 group">
      <th
        scope="row"
        className="t-data py-[3px] pr-3 text-right font-normal whitespace-nowrap"
      >
        <span className="text-ink">{topic.name}</span>
      </th>

      <td className="py-[3px]">
        <div className="relative h-[13px]">
          {/* The neutral axis. Drawn per row rather than once behind the block
              so it cannot drift out of alignment with the bars. */}
          <div className="bg-quiet absolute inset-y-0 left-1/2 w-px" aria-hidden />
          {/* The weak threshold at 0.60. */}
          <div
            className="border-quiet/60 absolute inset-y-0 border-l border-dashed"
            style={{ left: `${WEAK_THRESHOLD * 100}%` }}
            aria-hidden
          />
          <motion.div
            className={`absolute top-1/2 h-[5px] -translate-y-1/2 ${
              weak ? "bg-deficit" : "bg-surplus"
            }`}
            style={{
              left: `${left}%`,
              width: `${Math.max(width, 0.35)}%`,
              // The bar expands away from whichever end touches the axis.
              transformOrigin: scorePct >= 50 ? "left center" : "right center",
            }}
            initial={animate && !reduced ? { scaleX: 0 } : false}
            animate={{ scaleX: 1 }}
            transition={reduced ? INSTANT : { ...DRAW, delay: index * ROW_STAGGER }}
          />
        </div>
      </td>

      <td className="t-data-xs text-quiet py-[3px] pl-3 text-right whitespace-nowrap">
        {formatScore(topic.masteryScore)}
      </td>
      {/* The evidence behind the score, and the reason "weak" is never
          misread. Recursion sits at 0.5333 on a PERFECT 2/2 record — not a
          failure, just two data points. Printing 2/2 beside the score is what
          makes that legible without a footnote. */}
      <td className="t-data-xs text-quiet py-[3px] pl-3 text-right whitespace-nowrap">
        {formatEvidence(topic.solvedCount, topic.attemptedCount)}
      </td>
    </tr>
  );
}

function UnknownRow({ topic }: { topic: UnknownTopicView }) {
  return (
    <tr>
      <th
        scope="row"
        className="t-data text-quiet py-[3px] pr-3 text-right font-normal whitespace-nowrap"
      >
        {topic.name}
      </th>
      <td className="py-[3px]">
        <div className="relative h-[13px]">
          <div className="bg-quiet/50 absolute inset-y-0 left-1/2 w-px" aria-hidden />
          {/* A GRATICULE, NOT A BAR. Dotted across the full track width rather
              than a short mark of any length — a short mark would be read as a
              small quantity, and the whole point is that there is no quantity.
              This is a place where a measurement could go. */}
          <div
            className="absolute top-1/2 right-0 left-0 h-px -translate-y-1/2 opacity-60"
            style={{
              backgroundImage:
                "repeating-linear-gradient(to right, var(--quiet) 0 1px, transparent 1px 6px)",
            }}
            aria-hidden
          />
        </div>
      </td>
      {/* Em dashes, in every numeric column. Never 0, never 0.0000, never
          blank — each of those reads as a value. */}
      <td className="t-data-xs text-quiet py-[3px] pl-3 text-right">{NO_DATA}</td>
      <td className="t-data-xs text-quiet py-[3px] pl-3 text-right">{NO_DATA}</td>
    </tr>
  );
}

export function Spread({ overview }: { overview: MasteryOverview }) {
  // "Has the entrance already played this session?" is read during render but written
  // in an effect, so the render stays pure.
  const [animate] = useState(() => !hasIntroduced);
  useEffect(() => {
    hasIntroduced = true;
  }, []);

  // ONE CONTINUOUS MEASURED BLOCK, WEAKEST FIRST - weak and strong are not separate
  // tables. The 0.60 threshold is drawn as a line THROUGH the block, so the split reads
  // as a measured boundary rather than an arbitrary colour change.
  const measured = [...overview.weak, ...[...overview.strong].reverse()];

  return (
    <section aria-labelledby="spread-heading">
      <div id="spread-heading">
        <Header overview={overview} />
      </div>

      <table className="w-full table-fixed border-collapse">
        <Columns />
        <caption className="sr-only">
          Measured topics, weakest first. Mastery is a confidence-weighted score
          between 0 and 1 centred on 0.5; below 0.6 counts as weak.
        </caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">Topic</th>
            <th scope="col">Mastery, drawn as deviation from 0.5</th>
            <th scope="col">Mastery score</th>
            <th scope="col">Solved of attempted</th>
          </tr>
        </thead>
        <tbody>
          {measured.map((topic, index) => (
            <MeasuredRow
              key={topic.topicId}
              topic={topic}
              index={index}
              animate={animate}
            />
          ))}
        </tbody>
      </table>

      {/* Calibration, printed once under the block. Real ticks for a real
          scale — 0.50 is the prior the formula is centred on and 0.60 is the
          engine's WEAK_THRESHOLD, so both marks reference something.
          Hidden when nothing is measured: there is no scale to calibrate, and
          an axis under an empty block would imply the empty block is on it. */}
      <div
        className="mt-2 grid items-center"
        style={{ gridTemplateColumns: `${COL_LABEL} ${COL_TRACK} 1fr` }}
        hidden={measured.length === 0}
      >
        <div />
        <div className="relative h-4">
          <div className="bg-rule absolute top-0 right-0 left-0 h-px" aria-hidden />
          {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
            <div
              key={tick}
              className="bg-quiet absolute top-0 w-px"
              style={{ left: `${tick * 100}%`, height: tick === 0.5 ? 7 : 4 }}
              aria-hidden
            />
          ))}
          <span className="t-data-xs text-quiet absolute top-[7px] left-0">0.0</span>
          <span className="t-data-xs text-quiet absolute top-[7px] left-1/2 -translate-x-1/2">
            0.5
          </span>
          <span className="t-data-xs text-quiet absolute top-[7px] right-0">1.0</span>
        </div>
        <div />
      </div>

      {overview.unknown.length > 0 ? (
        <div className="mt-8">
          {/* THE REGISTER CHANGE, ANNOUNCED. A labelled break rather than a
              gap: the reader is told these rows are a different kind of thing
              before they see one. It is a separate table with its own caption,
              so the distinction reaches a screen reader too — not just a
              different colour. */}
          <div className="border-rule mb-2 border-t pt-2">
            <p className="t-data-xs text-quiet tracking-[0.14em] uppercase">
              No data yet · {overview.unknown.length} topics · not scored
            </p>
          </div>

          <table className="w-full table-fixed border-collapse">
            <Columns />
            <caption className="sr-only">
              Topics with no evidence. These have no mastery score — they are not
              scored zero, they are unmeasured. Solving one problem in any of
              them produces the first data point.
            </caption>
            <thead className="sr-only">
              <tr>
                <th scope="col">Topic</th>
                <th scope="col">No measurement</th>
                <th scope="col">Mastery score</th>
                <th scope="col">Solved of attempted</th>
              </tr>
            </thead>
            <tbody>
              {overview.unknown.map((topic) => (
                <UnknownRow key={topic.topicId} topic={topic} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
