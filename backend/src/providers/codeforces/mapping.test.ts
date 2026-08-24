import { DifficultyBand, SolveStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type { CfProblem, CfSubmission } from "./client";
import {
  aggregateSubmissions,
  classifyProblem,
  ratingToBand,
  toExternalId,
  toProblemUrl,
} from "./mapping";

const problem = (overrides: Partial<CfProblem> = {}): CfProblem => ({
  contestId: 1234,
  index: "A",
  name: "Example",
  rating: 1200,
  tags: ["math"],
  ...overrides,
});

const submission = (
  verdict: string | undefined,
  atSeconds: number,
  overrides: Partial<CfProblem> = {}
): CfSubmission => ({
  problem: problem(overrides),
  verdict,
  creationTimeSeconds: atSeconds,
});

const HOUR = 3600;

describe("ratingToBand", () => {
  it("flips from easy to medium exactly at 1200", () => {
    expect(ratingToBand(1199)).toBe(DifficultyBand.EASY);
    expect(ratingToBand(1200)).toBe(DifficultyBand.MEDIUM);
  });

  it("flips from medium to hard exactly at 1800", () => {
    expect(ratingToBand(1799)).toBe(DifficultyBand.MEDIUM);
    expect(ratingToBand(1800)).toBe(DifficultyBand.HARD);
  });

  it("maps the ends of the real Codeforces range", () => {
    expect(ratingToBand(800)).toBe(DifficultyBand.EASY);
    expect(ratingToBand(3500)).toBe(DifficultyBand.HARD);
  });
});

describe("toExternalId and toProblemUrl", () => {
  it("spells an id one way for every caller", () => {
    expect(toExternalId(1234, "A")).toBe("1234A");
    expect(toExternalId(921, "01")).toBe("92101");
  });

  it("switches to the gym URL space exactly at contest 100000", () => {
    // Gym contests 404 on the problemset URL, and only the user-sync path ever sees one.
    expect(toProblemUrl(99_999, "A")).toBe(
      "https://codeforces.com/problemset/problem/99999/A"
    );
    expect(toProblemUrl(100_000, "A")).toBe(
      "https://codeforces.com/gym/100000/problem/A"
    );
  });
});

describe("classifyProblem", () => {
  it("accepts a problem carrying both a contest id and a rating", () => {
    const result = classifyProblem(problem());
    expect(result.importable).toBe(true);
  });

  it("skips a problem with no contest id rather than fabricating one", () => {
    const result = classifyProblem(problem({ contestId: undefined }));
    expect(result).toEqual({ importable: false, reason: "no-contest-id" });
  });

  it("skips an unrated problem rather than inventing a band", () => {
    const result = classifyProblem(problem({ rating: undefined }));
    expect(result).toEqual({ importable: false, reason: "unrated" });
  });

  it("reports the missing contest id first when both are absent", () => {
    const result = classifyProblem(problem({ contestId: undefined, rating: undefined }));
    expect(result).toEqual({ importable: false, reason: "no-contest-id" });
  });
});

describe("aggregateSubmissions", () => {
  it("produces one row per problem, never one per submission", () => {
    const { solves } = aggregateSubmissions([
      submission("WRONG_ANSWER", HOUR),
      submission("WRONG_ANSWER", 2 * HOUR),
      submission("OK", 3 * HOUR),
    ]);
    expect(solves).toHaveLength(1);
    expect(solves[0].externalId).toBe("1234A");
  });

  it("keeps a problem solved even when a later submission failed", () => {
    const { solves } = aggregateSubmissions([
      submission("OK", HOUR),
      submission("WRONG_ANSWER", 2 * HOUR),
    ]);
    expect(solves[0].status).toBe(SolveStatus.SOLVED);
  });

  it("marks a problem solved by an accepted submission that arrived last", () => {
    const { solves } = aggregateSubmissions([
      submission("TIME_LIMIT_EXCEEDED", HOUR),
      submission("OK", 2 * HOUR),
    ]);
    expect(solves[0].status).toBe(SolveStatus.SOLVED);
  });

  it("counts every submission as an attempt, accepted ones included", () => {
    const { solves } = aggregateSubmissions([
      submission("WRONG_ANSWER", HOUR),
      submission("OK", 2 * HOUR),
      submission("OK", 3 * HOUR),
    ]);
    expect(solves[0].attemptCount).toBe(3);
  });

  it("records the earliest accepted submission and the latest of any verdict", () => {
    // These genuinely differ whenever someone resubmits after solving, so a bug
    // conflating them passes on most problems.
    const { solves } = aggregateSubmissions([
      submission("WRONG_ANSWER", HOUR),
      submission("OK", 2 * HOUR),
      submission("OK", 5 * HOUR),
      submission("WRONG_ANSWER", 9 * HOUR),
    ]);
    expect(solves[0].solvedAt).toEqual(new Date(2 * HOUR * 1000));
    expect(solves[0].lastAttemptedAt).toEqual(new Date(9 * HOUR * 1000));
  });

  it("finds the earliest accepted submission even when the input is unordered", () => {
    const { solves } = aggregateSubmissions([
      submission("OK", 5 * HOUR),
      submission("OK", 2 * HOUR),
    ]);
    expect(solves[0].solvedAt).toEqual(new Date(2 * HOUR * 1000));
    expect(solves[0].lastAttemptedAt).toEqual(new Date(5 * HOUR * 1000));
  });

  it("treats a submission still being judged as an attempt, never a solve", () => {
    const { solves } = aggregateSubmissions([submission(undefined, HOUR)]);
    expect(solves[0].status).toBe(SolveStatus.ATTEMPTED);
    expect(solves[0].solvedAt).toBeNull();
    expect(solves[0].attemptCount).toBe(1);
  });

  it("counts the two skip reasons separately and drops those submissions", () => {
    const { solves, skippedUnrated, skippedNoContestId } = aggregateSubmissions([
      submission("OK", HOUR, { rating: undefined }),
      submission("OK", HOUR, { rating: undefined, index: "B" }),
      submission("OK", HOUR, { contestId: undefined }),
      submission("OK", HOUR),
    ]);
    expect(skippedUnrated).toBe(2);
    expect(skippedNoContestId).toBe(1);
    expect(solves).toHaveLength(1);
  });

  it("returns nothing at all for an empty submission list", () => {
    expect(aggregateSubmissions([])).toEqual({
      solves: [],
      skippedUnrated: 0,
      skippedNoContestId: 0,
    });
  });

  it("sorts by external id so two identical runs issue identical writes", () => {
    const { solves } = aggregateSubmissions([
      submission("OK", HOUR, { index: "C" }),
      submission("OK", HOUR, { index: "A" }),
      submission("OK", HOUR, { contestId: 999, index: "B" }),
    ]);
    expect(solves.map((solve) => solve.externalId)).toEqual(["1234A", "1234C", "999B"]);
  });
});
