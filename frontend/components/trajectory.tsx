"use client";

import { formatDay, formatEvidence, formatScore, NO_DATA, absoluteTime } from "@/lib/format";
import type {
  Breakthrough,
  SummaryResponse,
  TrajectoryResponse,
  TrajectoryTopic,
  WeeklyMove,
} from "@/lib/types";

// Mastery over time, read off MasteryLog. The one thing this screen must not do is draw
// a continuous line through a period we know nothing about, so a gap in the data is
// drawn as an actual break in the line with the same dotted graticule the Spread uses
// for unmeasured topics. A straight segment across it would assert a value that was
// never measured, which is the exact failure the endpoint's nulls exist to prevent.

const WEAK_THRESHOLD = 0.6; // engine/mastery.ts — mirrored for display only

const SPARK_W = 300;
const SPARK_H = 34;

const COL_LABEL = "26%";
const COL_TRACK = "44%";

function Columns() {
  return (
    <colgroup>
      <col style={{ width: COL_LABEL }} />
      <col style={{ width: COL_TRACK }} />
      <col style={{ width: "16%" }} />
      <col style={{ width: "14%" }} />
    </colgroup>
  );
}

function stateColor(state: TrajectoryTopic["state"]): string {
  if (state === "weak") return "var(--deficit)";
  if (state === "strong") return "var(--surplus)";
  return "var(--quiet)";
}

// Consecutive stretches of the same kind, so each run of real values becomes its own
// polyline and no geometry is ever emitted across a run of nulls.
function segment(series: (number | null)[]) {
  const runs: { empty: boolean; from: number; to: number }[] = [];
  series.forEach((value, index) => {
    const empty = value === null;
    const last = runs[runs.length - 1];
    if (last && last.empty === empty) last.to = index;
    else runs.push({ empty, from: index, to: index });
  });
  return runs;
}

function Sparkline({ topic }: { topic: TrajectoryTopic }) {
  const n = topic.series.length;
  const step = n > 1 ? SPARK_W / (n - 1) : SPARK_W;
  const x = (index: number) => (n > 1 ? index * step : SPARK_W / 2);
  const y = (value: number) => (1 - value) * SPARK_H;
  const color = stateColor(topic.state);

  return (
    // preserveAspectRatio="none" lets one viewBox stretch to whatever the column is;
    // vector-effect below is what stops that non-uniform scale from smearing the
    // strokes and dashes along with it.
    <svg
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="none"
      className="block h-[34px] w-full"
      aria-hidden
    >
      {/* --rule is the hairline token, but at 34px on --paper it resolves to roughly
          1.3:1 and simply is not there. The legend names this line, so it is drawn in
          --quiet held back by opacity: legible as a reference, still behind the data. */}
      <line
        x1={0}
        y1={y(WEAK_THRESHOLD)}
        x2={SPARK_W}
        y2={y(WEAK_THRESHOLD)}
        stroke="var(--quiet)"
        strokeOpacity={0.45}
        strokeWidth={1}
        strokeDasharray="2 4"
        vectorEffect="non-scaling-stroke"
      />

      {segment(topic.series).map((run) => {
        if (run.empty) {
          // The same dotted graticule the Spread prints for a topic with no data, so a
          // break reads as the absence it is rather than as a rendering failure.
          const half = n > 1 ? step / 2 : 0;
          return (
            <line
              key={`gap-${run.from}`}
              x1={Math.max(0, x(run.from) - half)}
              y1={SPARK_H / 2}
              x2={Math.min(SPARK_W, x(run.to) + half)}
              y2={SPARK_H / 2}
              stroke="var(--quiet)"
              strokeWidth={1}
              strokeDasharray="1 5"
              vectorEffect="non-scaling-stroke"
            />
          );
        }

        // A single surviving point has no line to draw, so it gets a round-capped
        // vertical hairline instead - no horizontal extent, so the x-scale cannot
        // stretch it into a dash.
        if (run.from === run.to) {
          const value = topic.series[run.from] as number;
          return (
            <line
              key={`point-${run.from}`}
              x1={x(run.from)}
              y1={y(value) - 0.01}
              x2={x(run.from)}
              y2={y(value) + 0.01}
              stroke={color}
              strokeWidth={2.5}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          );
        }

        const points: string[] = [];
        for (let i = run.from; i <= run.to; i++) {
          points.push(`${x(i)},${y(topic.series[i] as number)}`);
        }
        return (
          <polyline
            key={`run-${run.from}`}
            points={points.join(" ")}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
    </svg>
  );
}

function TopicRow({ topic }: { topic: TrajectoryTopic }) {
  return (
    <tr className="border-rule border-b last:border-b-0">
      <th
        scope="row"
        className="t-body-sm text-ink truncate py-2 pr-3 text-left font-normal"
      >
        {topic.name}
      </th>
      <td className="py-2">
        <Sparkline topic={topic} />
      </td>
      <td className="t-data text-ink py-2 pr-3 text-right tabular-nums">
        {topic.current ? formatScore(topic.current.masteryScore) : NO_DATA}
      </td>
      <td className="t-data-xs text-quiet py-2 text-right tabular-nums">
        {topic.current
          ? formatEvidence(topic.current.solvedCount, topic.current.attemptedCount)
          : NO_DATA}
      </td>
    </tr>
  );
}

export function TrajectorySeries({ data }: { data: TrajectoryResponse }) {
  const first = data.buckets[0];
  const last = data.buckets[data.buckets.length - 1];

  return (
    <section aria-labelledby="series-heading">
      <div className="mb-3">
        <h2 id="series-heading" className="t-display">
          Per topic
        </h2>
        <p className="t-data-xs text-quiet mt-2 tracking-[0.1em] uppercase">
          {data.topics.length} topics · {formatDay(first)} to {formatDay(last)} ·{" "}
          {data.historyDays} {data.historyDays === 1 ? "day" : "days"} recorded
        </p>
      </div>

      <table className="w-full table-fixed border-collapse">
        <Columns />
        <caption className="sr-only">
          Each topic&apos;s mastery score over time, one point per day. The score column
          carries the current value; the drawn line is the same number over the window,
          and a break in it marks a period with no data rather than a score of zero.
        </caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">Topic</th>
            <th scope="col">Mastery over time</th>
            <th scope="col">Current mastery score</th>
            <th scope="col">Solved of attempted</th>
          </tr>
        </thead>
        <tbody>
          {data.topics.map((topic) => (
            <TopicRow key={topic.topicId} topic={topic} />
          ))}
        </tbody>
      </table>

      <div
        className="mt-2 grid items-center"
        style={{ gridTemplateColumns: `${COL_LABEL} ${COL_TRACK} 1fr` }}
      >
        <div />
        <div className="relative h-4">
          <div className="bg-rule absolute top-0 right-0 left-0 h-px" aria-hidden />
          <span className="t-data-xs text-quiet absolute top-[5px] left-0">
            {formatDay(first)}
          </span>
          <span className="t-data-xs text-quiet absolute top-[5px] right-0">
            {formatDay(last)}
          </span>
        </div>
        <div />
      </div>

      <p className="t-data-xs text-quiet mt-4 tracking-[0.1em] uppercase">
        Vertical scale 0.0 to 1.0 on every row · dashed rule at {WEAK_THRESHOLD} ·
        dotted span means no data
      </p>
    </section>
  );
}

function Readout({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-rule border-t pt-3">
      <p className="t-data-xs text-quiet tracking-[0.14em] uppercase">{label}</p>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function StreakReadout({ data }: { data: SummaryResponse }) {
  const streak = data.streak;

  if (!streak || streak.lastSolveDay === null) {
    return (
      <Readout label="Streak">
        <p className="t-data-lg text-quiet">{NO_DATA}</p>
        <p className="t-data-xs text-quiet mt-1">
          {data.reasons.streak ?? "No solves recorded"}
        </p>
      </Readout>
    );
  }

  // The label carries the distinction, not the number: a run that has ended is reported
  // at its real length under a different name rather than collapsed to zero.
  return (
    <Readout label={streak.current ? "Streak" : "Last run"}>
      <p className={`t-data-lg ${streak.current ? "text-ink" : "text-quiet"}`}>
        {streak.days} {streak.days === 1 ? "day" : "days"}
      </p>
      <p className="t-data-xs text-quiet mt-1">
        {streak.current ? "through" : "ended"} {formatDay(streak.lastSolveDay)}
      </p>
      <p className="t-data-xs text-quiet mt-1">
        as of last sync · {absoluteTime(streak.asOf)}
      </p>
    </Readout>
  );
}

function BreakthroughList({ items }: { items: Breakthrough[] }) {
  return (
    <ol>
      {items.map((item) => (
        <li
          key={`${item.topicId}-${item.date}`}
          className="flex items-baseline justify-between gap-3 py-1"
        >
          <span className="t-body-sm text-ink truncate">{item.name}</span>
          <span className="t-data-xs text-quiet shrink-0 tabular-nums">
            {formatDay(item.date)} · {formatScore(item.scoreBefore)} to{" "}
            {formatScore(item.scoreAfter)}
          </span>
        </li>
      ))}
    </ol>
  );
}

function BreakthroughReadout({ data }: { data: SummaryResponse }) {
  const { breakthroughs, pendingBreakthroughs } = data;

  return (
    <Readout label="Breakthroughs">
      {breakthroughs.length === 0 ? (
        <p className="t-body-sm text-quiet">
          {data.reasons.breakthroughs ??
            `No topic crossed ${WEAK_THRESHOLD} and held in the last ${data.days} days.`}
        </p>
      ) : (
        <BreakthroughList items={breakthroughs} />
      )}

      {pendingBreakthroughs.length > 0 ? (
        <div className="mt-3">
          <p className="t-data-xs text-quiet tracking-[0.1em] uppercase">
            Crossed today · not yet held a full day
          </p>
          <div className="mt-1">
            <BreakthroughList items={pendingBreakthroughs} />
          </div>
        </div>
      ) : null}
    </Readout>
  );
}

// Rounded up to the next marked step so the axis endpoint is a number worth printing
// rather than whatever the largest mover happened to be.
const DELTA_STEPS = [0.05, 0.1, 0.25, 0.5, 1];

function deltaScale(moves: WeeklyMove[]): number {
  const largest = Math.max(...moves.map((move) => Math.abs(move.delta)));
  return DELTA_STEPS.find((step) => step >= largest) ?? 1;
}

function MoverRow({ move, scale }: { move: WeeklyMove; scale: number }) {
  const rose = move.delta > 0;
  const width = (Math.abs(move.delta) / scale) * 50;

  return (
    <tr>
      <th
        scope="row"
        className="t-body-sm text-ink truncate py-1 pr-3 text-left font-normal"
      >
        {move.name}
      </th>
      <td className="py-1">
        <div className="relative h-[11px]">
          <div className="bg-quiet absolute inset-y-0 left-1/2 w-px" aria-hidden />
          <div
            className={`absolute top-1/2 h-[5px] -translate-y-1/2 ${
              rose ? "bg-surplus" : "bg-deficit"
            }`}
            style={{
              left: rose ? "50%" : `${50 - width}%`,
              width: `${Math.max(width, 0.35)}%`,
            }}
          />
        </div>
      </td>
      <td className="t-data-xs text-quiet py-1 text-right tabular-nums">
        {rose ? "+" : "-"}
        {formatScore(Math.abs(move.delta))}
      </td>
    </tr>
  );
}

function MoversReadout({ data }: { data: SummaryResponse }) {
  const moves = data.weeklyDelta;

  if (moves.length === 0) {
    return (
      <Readout label="Moved this week">
        <p className="t-body-sm text-quiet">
          {data.reasons.weeklyDelta ?? "No topic changed score in the last 7 days."}
        </p>
      </Readout>
    );
  }

  const scale = deltaScale(moves);

  return (
    <Readout label="Moved this week">
      <table className="w-full table-fixed border-collapse">
        <colgroup>
          <col style={{ width: "38%" }} />
          <col style={{ width: "44%" }} />
          <col style={{ width: "18%" }} />
        </colgroup>
        <caption className="sr-only">
          Topics whose mastery score moved most over the last seven days, drawn as
          deviation from no change. Topics with no data at either end are excluded
          rather than shown as unchanged.
        </caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">Topic</th>
            <th scope="col">Change, drawn as deviation from zero</th>
            <th scope="col">Change in mastery score</th>
          </tr>
        </thead>
        <tbody>
          {moves.map((move) => (
            <MoverRow key={move.topicId} move={move} scale={scale} />
          ))}
        </tbody>
      </table>
      <p className="t-data-xs text-quiet mt-2 tracking-[0.1em] uppercase">
        Scale plus or minus {formatScore(scale)}
      </p>
    </Readout>
  );
}

export function TrajectorySummary({ data }: { data: SummaryResponse }) {
  return (
    <section aria-labelledby="summary-heading" className="grid gap-6 sm:grid-cols-3">
      <h2 id="summary-heading" className="sr-only">
        Progress summary
      </h2>
      <StreakReadout data={data} />
      <BreakthroughReadout data={data} />
      <MoversReadout data={data} />
    </section>
  );
}
