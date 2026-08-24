import { DifficultyBand } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  aggregateSubmissions,
  difficultyToBand,
  toExternalId,
  toProblemUrl,
} from "./mapping";

const solve = (titleSlug: string, title: string, submittedAt: string) => ({
  titleSlug,
  title,
  submittedAt: new Date(submittedAt),
});

describe("difficultyToBand", () => {
  it("maps each of the three difficulties the API returns", () => {
    expect(difficultyToBand("Easy")).toBe(DifficultyBand.EASY);
    expect(difficultyToBand("Medium")).toBe(DifficultyBand.MEDIUM);
    expect(difficultyToBand("Hard")).toBe(DifficultyBand.HARD);
  });
});

describe("toExternalId and toProblemUrl", () => {
  it("keys on the title slug, which is stable and is the URL", () => {
    expect(toExternalId("two-sum")).toBe("two-sum");
  });

  it("builds the URL rather than taking whichever one the API happened to return", () => {
    // One import path returns a link field and the other returns none, so using theirs
    // would give the two paths different URLs for the same problem - and url is a column
    // the sync diffs on, which would make those rows flap forever.
    expect(toProblemUrl("two-sum")).toBe("https://leetcode.com/problems/two-sum/");
  });
});

describe("aggregateSubmissions", () => {
  it("collapses two accepted submissions for one problem into a single row", () => {
    // The 20-row window can hold two accepted submissions for one problem, and
    // UserProblem is one row per user and problem.
    const solves = aggregateSubmissions([
      solve("two-sum", "Two Sum", "2026-03-02T10:00:00Z"),
      solve("two-sum", "Two Sum", "2026-03-04T10:00:00Z"),
    ]);
    expect(solves).toHaveLength(1);
  });

  it("keeps the earliest accepted submission whichever order they arrive in", () => {
    const later = solve("two-sum", "Two Sum", "2026-03-04T10:00:00Z");
    const earlier = solve("two-sum", "Two Sum", "2026-03-02T10:00:00Z");
    expect(aggregateSubmissions([later, earlier])[0].solvedAt).toEqual(
      new Date("2026-03-02T10:00:00Z")
    );
    expect(aggregateSubmissions([earlier, later])[0].solvedAt).toEqual(
      new Date("2026-03-02T10:00:00Z")
    );
  });

  it("carries the title through alongside the slug", () => {
    const [row] = aggregateSubmissions([
      solve("two-sum", "Two Sum", "2026-03-02T10:00:00Z"),
    ]);
    expect(row).toEqual({
      externalId: "two-sum",
      titleSlug: "two-sum",
      title: "Two Sum",
      solvedAt: new Date("2026-03-02T10:00:00Z"),
    });
  });

  it("returns nothing for an empty submission list", () => {
    expect(aggregateSubmissions([])).toEqual([]);
  });

  it("sorts by external id so two identical runs issue identical writes", () => {
    const solves = aggregateSubmissions([
      solve("two-sum", "Two Sum", "2026-03-02T10:00:00Z"),
      solve("add-two-numbers", "Add Two Numbers", "2026-03-02T10:00:00Z"),
      solve("longest-substring", "Longest Substring", "2026-03-02T10:00:00Z"),
    ]);
    expect(solves.map((row) => row.externalId)).toEqual([
      "add-two-numbers",
      "longest-substring",
      "two-sum",
    ]);
  });
});
