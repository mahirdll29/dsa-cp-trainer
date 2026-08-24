import { DifficultyBand } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { DURATION_MINUTES, SIZES, SPREAD } from "./contestSelect";

const BANDS = [DifficultyBand.EASY, DifficultyBand.MEDIUM, DifficultyBand.HARD];

describe("the contest spread table", () => {
  it("covers every offered size and offers every covered size", () => {
    expect(Object.keys(SPREAD).map(Number).sort((a, b) => a - b)).toEqual([...SIZES]);
  });

  it("hands out exactly as many problems as the size promises", () => {
    for (const size of SIZES) {
      const total = BANDS.reduce((sum, band) => sum + SPREAD[size][band], 0);
      expect(total).toBe(size);
    }
  });

  it("never produces a single-band contest", () => {
    for (const size of SIZES) {
      for (const band of BANDS) {
        expect(SPREAD[size][band]).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("never gets easier as the contest grows", () => {
    for (let i = 1; i < SIZES.length; i++) {
      for (const band of BANDS) {
        expect(SPREAD[SIZES[i]][band]).toBeGreaterThanOrEqual(
          SPREAD[SIZES[i - 1]][band]
        );
      }
    }
  });
});

describe("the offered durations", () => {
  it("are ascending and positive", () => {
    let previous = 0;
    for (const minutes of DURATION_MINUTES) {
      expect(minutes).toBeGreaterThan(previous);
      previous = minutes;
    }
  });
});
