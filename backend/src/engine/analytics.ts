import { WEAK_THRESHOLD } from "./mastery";

// Reading MasteryLog, which is append-on-change rather than a daily snapshot. Two very
// different facts look identical in it - a value that persisted, and a value we stopped
// knowing - and telling them apart is what this module exists to do. Everything here is
// pure: rows in, arrays out, no Prisma. Both endpoints share it, and the fixtures that
// verify the gap rule need no database.

const DAY_MS = 86_400_000;

export type TopicState = "weak" | "strong" | "unknown";

export type LogRow = {
  topicId: string;
  masteryScore: number;
  capturedAt: Date;
};

// UNKNOWN is the absence of a value, never a low one: engine/mastery.ts buckets by whether
// a TopicMastery row exists, and a topic with no data is not a topic scored zero.
export function classify(score: number | null): TopicState {
  if (score === null) return "unknown";
  return score < WEAK_THRESHOLD ? "weak" : "strong";
}

// Shifting the instant and reading the UTC calendar date is exactly right for a fixed
// offset. tzOffsetMinutes is minutes AHEAD of UTC, the opposite sign to getTimezoneOffset().
export function dayKey(at: Date, tzOffsetMinutes: number): string {
  return new Date(at.getTime() + tzOffsetMinutes * 60_000)
    .toISOString()
    .slice(0, 10);
}

export function buildDayKeys(
  days: number,
  tzOffsetMinutes: number,
  now: Date
): string[] {
  const last = Date.parse(`${dayKey(now, tzOffsetMinutes)}T00:00:00Z`);
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    keys.push(new Date(last - i * DAY_MS).toISOString().slice(0, 10));
  }
  return keys;
}

export type SeriesResult = {
  series: Map<string, (number | null)[]>;
  historyDays: number;
};

export function buildSeries(
  rows: LogRow[],
  topicIdsWithCurrent: Set<string>,
  dayKeys: string[],
  tzOffsetMinutes: number
): SeriesResult {
  const firstKey = dayKeys[0];
  const lastKey = dayKeys[dayKeys.length - 1];

  const closing = new Map<string, Map<string, number>>();
  const seed = new Map<string, number>();
  const daysWithData = new Set<string>();

  // Ascending order makes the last write per (topic, day) the closing value, with no
  // per-row timestamp comparison. The first value of the day would be a different chart.
  const ordered = [...rows].sort(
    (a, b) => a.capturedAt.getTime() - b.capturedAt.getTime()
  );

  for (const row of ordered) {
    const key = dayKey(row.capturedAt, tzOffsetMinutes);
    if (key > lastKey) continue;
    // Rows older than the window still carry a value into it, so the line starts at the
    // left edge instead of opening on a false gap.
    if (key < firstKey) {
      seed.set(row.topicId, row.masteryScore);
      continue;
    }
    const byDay = closing.get(row.topicId) ?? new Map<string, number>();
    byDay.set(key, row.masteryScore);
    closing.set(row.topicId, byDay);
    daysWithData.add(key);
  }

  const topicIds = new Set([
    ...closing.keys(),
    ...seed.keys(),
    ...topicIdsWithCurrent,
  ]);

  const series = new Map<string, (number | null)[]>();

  for (const topicId of topicIds) {
    const byDay = closing.get(topicId);
    const values: (number | null)[] = [];
    let carried: number | null = seed.get(topicId) ?? null;
    let lastLoggedIndex = -1;

    dayKeys.forEach((key, index) => {
      const logged = byDay?.get(key);
      if (logged !== undefined) {
        carried = logged;
        lastLoggedIndex = index;
      }
      values.push(carried);
    });

    // Past the last row, only a live TopicMastery row proves the value persisted. Without
    // one the topic lost its data and Module 8 logs no terminal row, so the honest answer
    // is that we stopped knowing - never a carried value, never a zero.
    if (!topicIdsWithCurrent.has(topicId)) {
      for (let i = lastLoggedIndex + 1; i < values.length; i++) {
        values[i] = null;
      }
    }

    series.set(topicId, values);
  }

  return { series, historyDays: daysWithData.size };
}

export type Breakthrough = {
  topicId: string;
  date: string;
  scoreBefore: number;
  scoreAfter: number;
};

export function detectBreakthroughs(
  series: Map<string, (number | null)[]>,
  dayKeys: string[]
): { confirmed: Breakthrough[]; pending: Breakthrough[] } {
  const confirmed: Breakthrough[] = [];
  const pending: Breakthrough[] = [];

  for (const [topicId, values] of series) {
    for (let i = 1; i < values.length; i++) {
      const before = values[i - 1];
      const after = values[i];
      if (before === null || after === null) continue;
      // Only weak -> strong. During the first weeks every topic getting its first data
      // would otherwise fire one and drown the real signal.
      if (classify(before) !== "weak" || classify(after) !== "strong") continue;

      const crossing = {
        topicId,
        date: dayKeys[i],
        scoreBefore: before,
        scoreAfter: after,
      };

      // The hold bucket does not exist yet, so this crossing cannot be evaluated today.
      if (i === values.length - 1) {
        pending.push(crossing);
        continue;
      }
      // A gap at the hold bucket classifies as unknown, which is not strong.
      if (classify(values[i + 1]) === "strong") confirmed.push(crossing);
    }
  }

  const newestFirst = (a: Breakthrough, b: Breakthrough) =>
    b.date.localeCompare(a.date) || a.topicId.localeCompare(b.topicId);

  return {
    confirmed: confirmed.sort(newestFirst),
    pending: pending.sort(newestFirst),
  };
}

export type DeltaEntry = {
  topicId: string;
  from: number;
  to: number;
  delta: number;
};

export function weeklyDelta(
  series: Map<string, (number | null)[]>
): DeltaEntry[] {
  const entries: DeltaEntry[] = [];

  for (const [topicId, values] of series) {
    if (values.length < 7) continue;
    const from = values[values.length - 7];
    const to = values[values.length - 1];
    // A gap at either end is not a move of zero - we do not know what happened.
    if (from === null || to === null) continue;
    // Matches the 4dp the engine already rounds masteryScore to, so a subtraction does
    // not surface float noise the stored values never had.
    const delta = Math.round((to - from) * 10000) / 10000;
    if (delta === 0) continue;
    entries.push({ topicId, from, to, delta });
  }

  return entries.sort(
    (a, b) =>
      Math.abs(b.delta) - Math.abs(a.delta) || a.topicId.localeCompare(b.topicId)
  );
}

export type StreakResult = {
  days: number;
  current: boolean;
  lastSolveDay: string | null;
  asOf: string;
};

// Counted to lastSyncedAt rather than to today: a streak reading broken because a sync is
// stale would be measuring how often the user syncs, not how often they practise.
export function computeStreak(
  solvedAt: Date[],
  cutoff: Date,
  tzOffsetMinutes: number
): StreakResult {
  const cutoffDay = dayKey(cutoff, tzOffsetMinutes);
  const days = [...new Set(solvedAt.map((at) => dayKey(at, tzOffsetMinutes)))]
    .filter((day) => day <= cutoffDay)
    .sort();

  if (days.length === 0) {
    return {
      days: 0,
      current: false,
      lastSolveDay: null,
      asOf: cutoff.toISOString(),
    };
  }

  let run = 1;
  for (let i = days.length - 1; i > 0; i--) {
    const step =
      Date.parse(`${days[i]}T00:00:00Z`) - Date.parse(`${days[i - 1]}T00:00:00Z`);
    if (step !== DAY_MS) break;
    run++;
  }

  const lastSolveDay = days[days.length - 1];
  const behind =
    Date.parse(`${cutoffDay}T00:00:00Z`) -
    Date.parse(`${lastSolveDay}T00:00:00Z`);

  // A run is still alive with nothing solved yet on the cutoff day itself; two days back
  // it is over. The run length is reported either way and current says which it is.
  return {
    days: run,
    current: behind <= DAY_MS,
    lastSolveDay,
    asOf: cutoff.toISOString(),
  };
}
