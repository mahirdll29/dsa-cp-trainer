import { describe, expect, it } from "vitest";
import { addDays, intervalForRepetition, REVISION_INTERVALS } from "./revision";

const DAY_MS = 86_400_000;

describe("intervalForRepetition", () => {
  it("walks the ladder one rung per repetition", () => {
    expect(intervalForRepetition(0)).toBe(1);
    expect(intervalForRepetition(1)).toBe(3);
    expect(intervalForRepetition(2)).toBe(7);
    expect(intervalForRepetition(3)).toBe(14);
    expect(intervalForRepetition(4)).toBe(30);
  });

  it("holds at the last rung instead of running off the end", () => {
    expect(intervalForRepetition(5)).toBe(30);
    expect(intervalForRepetition(6)).toBe(30);
    expect(intervalForRepetition(100)).toBe(30);
  });

  it("never returns undefined for any repetition count", () => {
    for (let repetition = 0; repetition <= 50; repetition++) {
      expect(intervalForRepetition(repetition)).toBeGreaterThan(0);
    }
  });
});

describe("REVISION_INTERVALS", () => {
  it("is strictly ascending, so a later repetition never schedules sooner", () => {
    for (let i = 1; i < REVISION_INTERVALS.length; i++) {
      expect(REVISION_INTERVALS[i]).toBeGreaterThan(REVISION_INTERVALS[i - 1]);
    }
  });
});

describe("addDays", () => {
  it("advances by exact 24-hour multiples", () => {
    const from = new Date("2026-03-01T09:15:30.500Z");
    expect(addDays(from, 1).getTime() - from.getTime()).toBe(DAY_MS);
    expect(addDays(from, 30).getTime() - from.getTime()).toBe(30 * DAY_MS);
  });

  it("returns the same instant for zero days and goes backwards for a negative count", () => {
    const from = new Date("2026-03-01T09:15:30.500Z");
    expect(addDays(from, 0).getTime()).toBe(from.getTime());
    expect(addDays(from, -2).getTime()).toBe(from.getTime() - 2 * DAY_MS);
  });

  it("does not mutate its input", () => {
    const from = new Date("2026-03-01T09:15:30.500Z");
    const before = from.getTime();
    addDays(from, 14);
    expect(from.getTime()).toBe(before);
  });

  it("is unaffected by daylight saving transitions", () => {
    // Epoch-millisecond arithmetic, so local clock changes cannot shorten or lengthen a
    // day. Both of these span a transition in some zone the app may run in.
    const europeSpring = new Date("2026-03-28T23:30:00Z");
    const usFall = new Date("2026-10-31T23:30:00Z");
    expect(addDays(europeSpring, 1).getTime() - europeSpring.getTime()).toBe(DAY_MS);
    expect(addDays(usFall, 1).getTime() - usFall.getTime()).toBe(DAY_MS);
  });

  it("preserves the time of day, so a due date lands at the review instant", () => {
    const from = new Date("2026-03-01T09:15:30.500Z");
    expect(addDays(from, 7).toISOString().slice(11)).toBe("09:15:30.500Z");
  });
});

describe("the schedule the two combine to produce", () => {
  it("counts each rung from the review instant, not from the previous due date", () => {
    const reviewedAt = new Date("2026-03-01T12:00:00Z");
    const dueAfter = (repetition: number) =>
      addDays(reviewedAt, intervalForRepetition(repetition));

    expect(dueAfter(0).toISOString()).toBe("2026-03-02T12:00:00.000Z");
    expect(dueAfter(1).toISOString()).toBe("2026-03-04T12:00:00.000Z");
    expect(dueAfter(2).toISOString()).toBe("2026-03-08T12:00:00.000Z");
    expect(dueAfter(3).toISOString()).toBe("2026-03-15T12:00:00.000Z");
    expect(dueAfter(4).toISOString()).toBe("2026-03-31T12:00:00.000Z");
    expect(dueAfter(5).toISOString()).toBe("2026-03-31T12:00:00.000Z");
  });
});
