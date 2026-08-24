import { describe, expect, it } from "vitest";
import {
  buildDayKeys,
  buildSeries,
  classify,
  computeStreak,
  dayKey,
  detectBreakthroughs,
  LogRow,
  weeklyDelta,
} from "./analytics";

const row = (topicId: string, masteryScore: number, capturedAt: string): LogRow => ({
  topicId,
  masteryScore,
  capturedAt: new Date(capturedAt),
});

const KEYS = ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"];

describe("classify", () => {
  it("treats a missing value as unknown and a low value as weak", () => {
    expect(classify(null)).toBe("unknown");
    expect(classify(0)).toBe("weak");
  });

  it("flips from weak to strong exactly at the threshold", () => {
    expect(classify(0.5999)).toBe("weak");
    expect(classify(0.6)).toBe("strong");
  });

  it("classifies a perfect score as strong", () => {
    expect(classify(1)).toBe("strong");
  });
});

describe("dayKey", () => {
  it("reads the UTC calendar date at a zero offset", () => {
    expect(dayKey(new Date("2026-03-01T23:59:59Z"), 0)).toBe("2026-03-01");
  });

  it("rolls a late-evening UTC instant into the next day at a positive offset", () => {
    // Minutes AHEAD of UTC, the opposite sign to Date.getTimezoneOffset(). 18:31Z is one
    // minute past midnight in IST.
    expect(dayKey(new Date("2026-03-01T18:31:00Z"), 330)).toBe("2026-03-02");
    expect(dayKey(new Date("2026-03-01T18:29:00Z"), 330)).toBe("2026-03-01");
  });

  it("rolls an early-morning UTC instant back a day at a negative offset", () => {
    expect(dayKey(new Date("2026-03-02T07:00:00Z"), -480)).toBe("2026-03-01");
  });
});

describe("buildDayKeys", () => {
  it("returns exactly the requested number of ascending keys, ending on today", () => {
    expect(buildDayKeys(5, 0, new Date("2026-03-05T10:00:00Z"))).toEqual(KEYS);
  });

  it("ends on the requested timezone's today, not on UTC's", () => {
    const keys = buildDayKeys(2, 330, new Date("2026-03-01T18:31:00Z"));
    expect(keys[keys.length - 1]).toBe("2026-03-02");
  });

  it("steps one calendar day at a time across a month boundary", () => {
    expect(buildDayKeys(3, 0, new Date("2026-04-01T10:00:00Z"))).toEqual([
      "2026-03-30",
      "2026-03-31",
      "2026-04-01",
    ]);
  });

  it("steps across a leap day", () => {
    expect(buildDayKeys(3, 0, new Date("2028-03-01T10:00:00Z"))).toEqual([
      "2028-02-28",
      "2028-02-29",
      "2028-03-01",
    ]);
  });
});

describe("buildSeries carry-forward and gap rule", () => {
  it("carries the last value forward when the topic still has current mastery", () => {
    const { series } = buildSeries(
      [row("dp", 0.7, "2026-03-01T10:00:00Z")],
      new Set(["dp"]),
      KEYS,
      0
    );
    expect(series.get("dp")).toEqual([0.7, 0.7, 0.7, 0.7, 0.7]);
  });

  it("stops at the last row when the topic has no current mastery", () => {
    // No TopicMastery row means the data was lost, and Module 8 writes no terminal row, so
    // the honest answer past the last entry is that we stopped knowing.
    const { series } = buildSeries(
      [row("dp", 0.7, "2026-03-01T10:00:00Z")],
      new Set(),
      KEYS,
      0
    );
    expect(series.get("dp")).toEqual([0.7, null, null, null, null]);
  });

  it("carries between two logged rows even when the topic has no current mastery", () => {
    // The rule is directional: only the stretch AFTER the last row is nulled. Applying the
    // current-mastery check uniformly punches holes in the middle of live history.
    const { series } = buildSeries(
      [row("dp", 0.4, "2026-03-01T10:00:00Z"), row("dp", 0.8, "2026-03-04T10:00:00Z")],
      new Set(),
      KEYS,
      0
    );
    expect(series.get("dp")).toEqual([0.4, 0.4, 0.4, 0.8, null]);
  });

  it("leaves nulls before a first row even when the topic is currently mastered", () => {
    const { series } = buildSeries(
      [row("dp", 0.7, "2026-03-03T10:00:00Z")],
      new Set(["dp"]),
      KEYS,
      0
    );
    expect(series.get("dp")).toEqual([null, null, 0.7, 0.7, 0.7]);
  });

  it("never carries a value across a gap once the line has been nulled", () => {
    const { series } = buildSeries(
      [row("dp", 0.7, "2026-03-01T10:00:00Z")],
      new Set(),
      KEYS,
      0
    );
    expect(series.get("dp")?.slice(1).every((value) => value === null)).toBe(true);
  });

  it("seeds the left edge from a row older than the window", () => {
    const { series } = buildSeries(
      [row("dp", 0.55, "2026-02-01T10:00:00Z")],
      new Set(["dp"]),
      KEYS,
      0
    );
    expect(series.get("dp")).toEqual([0.55, 0.55, 0.55, 0.55, 0.55]);
  });

  it("takes the closing value when a day holds more than one row", () => {
    const { series } = buildSeries(
      [row("dp", 0.3, "2026-03-02T22:00:00Z"), row("dp", 0.9, "2026-03-02T08:00:00Z")],
      new Set(["dp"]),
      KEYS,
      0
    );
    expect(series.get("dp")?.[1]).toBe(0.3);
  });

  it("ignores a row past the end of the window", () => {
    const { series } = buildSeries(
      [row("dp", 0.7, "2026-03-01T10:00:00Z"), row("dp", 0.2, "2026-04-01T10:00:00Z")],
      new Set(["dp"]),
      KEYS,
      0
    );
    expect(series.get("dp")).toEqual([0.7, 0.7, 0.7, 0.7, 0.7]);
  });

  it("emits an all-null row for a currently-mastered topic with no history", () => {
    const { series } = buildSeries([], new Set(["dp"]), KEYS, 0);
    expect(series.get("dp")).toEqual([null, null, null, null, null]);
  });

  it("counts distinct in-window days with data, not rows", () => {
    const { historyDays } = buildSeries(
      [
        row("dp", 0.3, "2026-03-02T08:00:00Z"),
        row("dp", 0.4, "2026-03-02T22:00:00Z"),
        row("graphs", 0.5, "2026-03-02T09:00:00Z"),
        row("dp", 0.6, "2026-03-04T09:00:00Z"),
        row("dp", 0.1, "2026-02-01T09:00:00Z"),
      ],
      new Set(),
      KEYS,
      0
    );
    expect(historyDays).toBe(2);
  });
});

describe("detectBreakthroughs", () => {
  const series = (values: (number | null)[]) => new Map([["dp", values]]);

  it("confirms a weak-to-strong crossing that holds", () => {
    const { confirmed, pending } = detectBreakthroughs(
      series([0.5, 0.7, 0.7, 0.7, 0.7]),
      KEYS
    );
    expect(pending).toEqual([]);
    expect(confirmed).toEqual([
      { topicId: "dp", date: "2026-03-02", scoreBefore: 0.5, scoreAfter: 0.7 },
    ]);
  });

  it("marks a crossing at the last bucket pending, since the hold bucket does not exist", () => {
    const { confirmed, pending } = detectBreakthroughs(
      series([0.5, 0.5, 0.5, 0.5, 0.7]),
      KEYS
    );
    expect(confirmed).toEqual([]);
    expect(pending.map((entry) => entry.date)).toEqual(["2026-03-05"]);
  });

  it("drops a crossing whose hold bucket is a gap", () => {
    const { confirmed, pending } = detectBreakthroughs(
      series([0.5, 0.7, null, null, null]),
      KEYS
    );
    expect(confirmed).toEqual([]);
    expect(pending).toEqual([]);
  });

  it("never fires on a topic arriving straight at strong from no data", () => {
    const { confirmed, pending } = detectBreakthroughs(
      series([null, 0.7, 0.7, 0.7, 0.7]),
      KEYS
    );
    expect(confirmed).toEqual([]);
    expect(pending).toEqual([]);
  });

  it("never fires on a topic that was already strong", () => {
    expect(detectBreakthroughs(series([0.7, 0.8, 0.8, 0.8, 0.8]), KEYS).confirmed).toEqual(
      []
    );
  });

  it("never fires on a strong-to-weak fall", () => {
    const { confirmed, pending } = detectBreakthroughs(
      series([0.8, 0.4, 0.4, 0.4, 0.4]),
      KEYS
    );
    expect(confirmed).toEqual([]);
    expect(pending).toEqual([]);
  });

  it("orders newest first and breaks ties on topic id", () => {
    const { confirmed } = detectBreakthroughs(
      new Map([
        ["graphs", [0.5, 0.7, 0.7, 0.7, 0.7]],
        ["dp", [0.5, 0.7, 0.7, 0.7, 0.7]],
        ["trees", [0.5, 0.5, 0.5, 0.7, 0.7]],
      ]),
      KEYS
    );
    expect(confirmed.map((entry) => [entry.date, entry.topicId])).toEqual([
      ["2026-03-04", "trees"],
      ["2026-03-02", "dp"],
      ["2026-03-02", "graphs"],
    ]);
  });
});

describe("weeklyDelta", () => {
  const week = (values: (number | null)[]) => new Map([["dp", values]]);

  it("ignores a series shorter than a week", () => {
    expect(weeklyDelta(week([0.1, 0.2, 0.3, 0.4, 0.5, 0.9]))).toEqual([]);
  });

  it("measures from seven buckets back to the last", () => {
    expect(weeklyDelta(week([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]))).toEqual([
      { topicId: "dp", from: 0.1, to: 0.7, delta: 0.6 },
    ]);
  });

  it("reports a fall as a negative delta", () => {
    expect(weeklyDelta(week([0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.3]))[0].delta).toBe(-0.5);
  });

  it("excludes a gap at either end rather than calling it a move of zero", () => {
    expect(weeklyDelta(week([null, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]))).toEqual([]);
    expect(weeklyDelta(week([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, null]))).toEqual([]);
  });

  it("excludes a topic that did not move", () => {
    expect(weeklyDelta(week([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]))).toEqual([]);
  });

  it("rounds so a subtraction cannot surface float noise", () => {
    expect(weeklyDelta(week([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.3]))[0].delta).toBe(0.2);
  });

  it("orders by absolute movement and breaks ties on topic id", () => {
    const entries = weeklyDelta(
      new Map([
        ["graphs", [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.6]],
        ["dp", [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.4]],
        ["trees", [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.9]],
      ])
    );
    expect(entries.map((entry) => entry.topicId)).toEqual(["trees", "dp", "graphs"]);
  });
});

describe("computeStreak", () => {
  const cutoff = new Date("2026-03-05T12:00:00Z");
  const at = (day: string) => new Date(day + "T10:00:00Z");

  it("reports nothing for a user who has solved nothing", () => {
    expect(computeStreak([], cutoff, 0)).toEqual({
      days: 0,
      current: false,
      lastSolveDay: null,
      asOf: cutoff.toISOString(),
    });
  });

  it("counts consecutive days as one run", () => {
    const result = computeStreak(
      [at("2026-03-03"), at("2026-03-04"), at("2026-03-05")],
      cutoff,
      0
    );
    expect(result.days).toBe(3);
    expect(result.current).toBe(true);
    expect(result.lastSolveDay).toBe("2026-03-05");
  });

  it("breaks the run at a missing day", () => {
    const result = computeStreak(
      [at("2026-03-01"), at("2026-03-03"), at("2026-03-04")],
      cutoff,
      0
    );
    expect(result.days).toBe(2);
  });

  it("counts a run as still alive with nothing solved yet on the cutoff day", () => {
    const result = computeStreak([at("2026-03-03"), at("2026-03-04")], cutoff, 0);
    expect(result.days).toBe(2);
    expect(result.current).toBe(true);
  });

  it("ends a run two days behind the cutoff but still reports its length", () => {
    const result = computeStreak([at("2026-03-02"), at("2026-03-03")], cutoff, 0);
    expect(result.days).toBe(2);
    expect(result.current).toBe(false);
    expect(result.lastSolveDay).toBe("2026-03-03");
  });

  it("ignores solves after the cutoff", () => {
    const result = computeStreak([at("2026-03-04"), at("2026-03-09")], cutoff, 0);
    expect(result.lastSolveDay).toBe("2026-03-04");
    expect(result.days).toBe(1);
  });

  it("counts several solves on one day once", () => {
    const result = computeStreak(
      [
        new Date("2026-03-05T01:00:00Z"),
        new Date("2026-03-05T09:00:00Z"),
        new Date("2026-03-05T11:00:00Z"),
      ],
      cutoff,
      0
    );
    expect(result.days).toBe(1);
  });

  it("does not depend on the order the solves arrive in", () => {
    const days = [at("2026-03-03"), at("2026-03-04"), at("2026-03-05")];
    expect(computeStreak([...days].reverse(), cutoff, 0)).toEqual(
      computeStreak(days, cutoff, 0)
    );
  });

  it("files a late-evening solve under the following day at a positive offset", () => {
    const lateEvening = new Date("2026-03-04T19:00:00Z");
    expect(computeStreak([lateEvening], cutoff, 0).lastSolveDay).toBe("2026-03-04");
    expect(computeStreak([lateEvening], cutoff, 330).lastSolveDay).toBe("2026-03-05");
  });
});
