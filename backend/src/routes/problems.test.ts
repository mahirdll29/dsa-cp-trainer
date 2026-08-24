import { Provider } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  byRelevance,
  ratingDistance,
  ratingOf,
  roundScore,
  topicWeight,
} from "./problems";

// Measured against the live catalog: 13,410 problems carrying topics, `math` on 4,036 of
// them and `queue` on 47. These are the frequencies the weighting was designed around.
const CATALOG_SIZE = 13_410;
const MATH_FREQUENCY = 4_036;
const QUEUE_FREQUENCY = 47;

const candidate = (problemId: string, score: number, distance: number) => ({
  problemId,
  score,
  sharedTopicIds: [],
  ratingDistance: distance,
});

describe("topicWeight", () => {
  it("gives a topic on every problem a weight above zero", () => {
    // Under plain ln(N/df) this is 0, and a source whose topics are all universal then
    // divides zero by zero. The smoothing is what keeps the score a number.
    expect(topicWeight(CATALOG_SIZE, CATALOG_SIZE)).toBeCloseTo(Math.LN2, 10);
    expect(topicWeight(CATALOG_SIZE, CATALOG_SIZE)).toBeGreaterThan(0);
  });

  it("weighs a rare topic above a ubiquitous one", () => {
    expect(topicWeight(QUEUE_FREQUENCY, CATALOG_SIZE)).toBeGreaterThan(
      topicWeight(MATH_FREQUENCY, CATALOG_SIZE)
    );
  });

  it("falls as a topic gets more common", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (const frequency of [1, 47, 500, 4_036, 10_000, CATALOG_SIZE]) {
      const weight = topicWeight(frequency, CATALOG_SIZE);
      expect(weight).toBeLessThan(previous);
      previous = weight;
    }
  });

  it("is finite and positive across the whole frequency range", () => {
    for (let frequency = 1; frequency <= CATALOG_SIZE; frequency += 137) {
      const weight = topicWeight(frequency, CATALOG_SIZE);
      expect(Number.isFinite(weight)).toBe(true);
      expect(weight).toBeGreaterThan(0);
    }
  });
});

describe("ratingOf", () => {
  it("reads a Codeforces rating as a number", () => {
    expect(ratingOf(Provider.CODEFORCES, "1600")).toBe(1600);
  });

  it("refuses to give a LeetCode problem a rating", () => {
    // The two scales do not map onto each other, and inventing a mapping is the thing
    // this module exists to refuse.
    expect(ratingOf(Provider.LEETCODE, "Medium")).toBeNull();
    expect(ratingOf(Provider.LEETCODE, "1600")).toBeNull();
  });
});

describe("ratingDistance", () => {
  it("is zero for equal ratings and symmetric otherwise", () => {
    expect(ratingDistance(1600, 1600)).toBe(0);
    expect(ratingDistance(1600, 1900)).toBe(300);
    expect(ratingDistance(1900, 1600)).toBe(300);
  });

  it("is infinite when either side is unrated", () => {
    expect(ratingDistance(null, 1600)).toBe(Number.POSITIVE_INFINITY);
    expect(ratingDistance(1600, null)).toBe(Number.POSITIVE_INFINITY);
    expect(ratingDistance(null, null)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("roundScore", () => {
  it("rounds to four places", () => {
    expect(roundScore(0.123456789)).toBe(0.1235);
    expect(roundScore(1)).toBe(1);
    expect(roundScore(0)).toBe(0);
  });

  it("collapses two scores that differ only in float noise", () => {
    expect(roundScore(0.3)).toBe(roundScore(0.1 + 0.2));
  });
});

describe("byRelevance", () => {
  it("puts the higher score first", () => {
    const ranked = [candidate("b", 0.2, 0), candidate("a", 0.9, 400)].sort(byRelevance);
    expect(ranked.map((entry) => entry.problemId)).toEqual(["a", "b"]);
  });

  it("breaks an equal score on the smaller rating distance", () => {
    const ranked = [
      candidate("far", 0.5, 400),
      candidate("near", 0.5, 100),
      candidate("exact", 0.5, 0),
    ].sort(byRelevance);
    expect(ranked.map((entry) => entry.problemId)).toEqual(["exact", "near", "far"]);
  });

  it("breaks an equal score and distance on the problem id", () => {
    const ranked = [
      candidate("c", 0.5, 100),
      candidate("a", 0.5, 100),
      candidate("b", 0.5, 100),
    ].sort(byRelevance);
    expect(ranked.map((entry) => entry.problemId)).toEqual(["a", "b", "c"]);
  });

  it("orders two unrated candidates by id rather than leaving them arbitrary", () => {
    // Both distances are Infinity, so the subtraction is NaN. NaN is falsy, which drops
    // through to the id exactly as an equal distance does - where a null branch here
    // would have been non-transitive and made the sort implementation-defined.
    const unrated = Number.POSITIVE_INFINITY;
    const ranked = [
      candidate("c", 0.5, unrated),
      candidate("a", 0.5, unrated),
      candidate("b", 0.5, unrated),
    ].sort(byRelevance);
    expect(ranked.map((entry) => entry.problemId)).toEqual(["a", "b", "c"]);
  });

  it("puts a rated candidate above an unrated one at an equal score", () => {
    const ranked = [
      candidate("unrated", 0.5, Number.POSITIVE_INFINITY),
      candidate("rated", 0.5, 900),
    ].sort(byRelevance);
    expect(ranked.map((entry) => entry.problemId)).toEqual(["rated", "unrated"]);
  });

  it("produces one order regardless of the order the candidates arrived in", () => {
    const candidates = [
      candidate("e", 0.5, Number.POSITIVE_INFINITY),
      candidate("d", 0.5, 100),
      candidate("c", 0.5, 100),
      candidate("b", 0.9, 400),
      candidate("a", 0.9, 0),
    ];
    const forwards = [...candidates].sort(byRelevance).map((entry) => entry.problemId);
    const backwards = [...candidates]
      .reverse()
      .sort(byRelevance)
      .map((entry) => entry.problemId);
    expect(forwards).toEqual(["a", "b", "c", "d", "e"]);
    expect(backwards).toEqual(forwards);
  });
});
