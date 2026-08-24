import { DifficultyBand } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { classify } from "./analytics";
import { calculateMasteryScore, masteryToBand, WEAK_THRESHOLD } from "./mastery";

describe("calculateMasteryScore", () => {
  it("returns the neutral prior when there is no evidence at all", () => {
    expect(calculateMasteryScore(0, 0)).toBe(0.5);
  });

  it("barely moves off neutral on a single data point", () => {
    expect(calculateMasteryScore(1, 0)).toBe(0.51);
    expect(calculateMasteryScore(0, 1)).toBe(0.49);
  });

  it("ranks a high-volume solver above a user with one solve", () => {
    expect(calculateMasteryScore(1, 0)).toBeLessThan(calculateMasteryScore(40, 10));
  });

  it("ranks a perfect record at low volume below a strong record at high volume", () => {
    expect(calculateMasteryScore(3, 0)).toBeLessThan(calculateMasteryScore(45, 5));
  });

  it("keeps an all-solved topic below 1 and raises it with volume", () => {
    expect(calculateMasteryScore(5, 0)).toBeLessThan(calculateMasteryScore(50, 0));
    expect(calculateMasteryScore(50, 0)).toBeLessThan(1);
  });

  it("keeps an all-attempted topic above 0 and lowers it with volume", () => {
    expect(calculateMasteryScore(0, 50)).toBeLessThan(calculateMasteryScore(0, 5));
    expect(calculateMasteryScore(0, 50)).toBeGreaterThan(0);
  });

  it("damps a topic toward neutral only while it is below the volume target", () => {
    const smoothedRate = (solved: number, attempted: number) =>
      Math.round(((solved + 2) / (solved + attempted + 4)) * 10000) / 10000;

    // At a total of 10 or more the confidence term is saturated, so the score is the
    // smoothed success rate outright.
    expect(calculateMasteryScore(8, 2)).toBe(smoothedRate(8, 2));
    expect(calculateMasteryScore(80, 20)).toBe(smoothedRate(80, 20));

    // Below it the same ratio is pulled toward the neutral prior.
    expect(calculateMasteryScore(4, 1)).toBeLessThan(smoothedRate(4, 1));
    expect(calculateMasteryScore(4, 1)).toBeGreaterThan(0.5);
  });

  it("never falls when a solve is added", () => {
    for (let solved = 0; solved < 20; solved++) {
      expect(calculateMasteryScore(solved + 1, 5)).toBeGreaterThan(
        calculateMasteryScore(solved, 5)
      );
    }
  });

  it("never rises when an unsolved attempt is added", () => {
    for (let attempted = 0; attempted < 20; attempted++) {
      expect(calculateMasteryScore(5, attempted + 1)).toBeLessThan(
        calculateMasteryScore(5, attempted)
      );
    }
  });

  it("stays inside 0..1 across the input space", () => {
    for (const solved of [0, 1, 7, 100, 5000]) {
      for (const attempted of [0, 1, 7, 100, 5000]) {
        const score = calculateMasteryScore(solved, attempted);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    }
  });

  it("is already rounded to four places, so two recomputes cannot differ in a diff", () => {
    for (const solved of [0, 1, 3, 17, 233]) {
      for (const attempted of [0, 1, 3, 17, 233]) {
        const score = calculateMasteryScore(solved, attempted);
        expect(Math.round(score * 10000) / 10000).toBe(score);
      }
    }
  });

  it("lands exactly on the weak threshold at 10 solved and 6 attempted", () => {
    expect(calculateMasteryScore(10, 6)).toBe(WEAK_THRESHOLD);
  });

  it("classifies a score sitting exactly on the weak threshold as strong", () => {
    // The comparison is `< WEAK_THRESHOLD`, so the boundary value itself is strong.
    expect(classify(calculateMasteryScore(10, 6))).toBe("strong");
    expect(classify(calculateMasteryScore(9, 6))).toBe("weak");
  });
});

describe("masteryToBand", () => {
  it("flips from easy to medium exactly at 0.45", () => {
    expect(masteryToBand(0.4499)).toBe(DifficultyBand.EASY);
    expect(masteryToBand(0.45)).toBe(DifficultyBand.MEDIUM);
  });

  it("flips from medium to hard exactly at 0.7", () => {
    expect(masteryToBand(0.6999)).toBe(DifficultyBand.MEDIUM);
    expect(masteryToBand(0.7)).toBe(DifficultyBand.HARD);
  });

  it("maps the extremes of the range", () => {
    expect(masteryToBand(0)).toBe(DifficultyBand.EASY);
    expect(masteryToBand(1)).toBe(DifficultyBand.HARD);
  });

  it("gives a topic with no evidence a medium target rather than an easy one", () => {
    expect(masteryToBand(calculateMasteryScore(0, 0))).toBe(DifficultyBand.MEDIUM);
  });

  it("targets medium for a topic that is already strong, since the two cutoffs are independent", () => {
    const score = calculateMasteryScore(10, 6);
    expect(classify(score)).toBe("strong");
    expect(masteryToBand(score)).toBe(DifficultyBand.MEDIUM);
  });
});
