import { DifficultyBand, Provider } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { primaryTopicName, toRecommendation } from "./recommend";

// Only the two pure pieces of the pipeline are reachable here. The stage ordering that
// makes the engine deterministic is enforced by Postgres orderBy clauses, so verifying
// it end to end needs a database and is out of scope.

const problem = (topicNames: string[]) => ({
  id: "problem-1",
  title: "Example",
  url: "https://codeforces.com/problemset/problem/1234/A",
  provider: Provider.CODEFORCES,
  difficultyRaw: "1200",
  difficultyBand: DifficultyBand.MEDIUM,
  problemTopics: topicNames.map((name) => ({ topic: { name } })),
});

describe("toRecommendation", () => {
  it("renders a problem's topics in one order however they arrive", () => {
    const forwards = toRecommendation(problem(["graphs", "dp", "trees"]), "why");
    const backwards = toRecommendation(problem(["trees", "graphs", "dp"]), "why");
    expect(forwards.topics).toEqual(["dp", "graphs", "trees"]);
    expect(backwards.topics).toEqual(forwards.topics);
  });

  it("passes the reason through untouched", () => {
    expect(toRecommendation(problem(["dp"]), "weak in Dynamic Programming").reason).toBe(
      "weak in Dynamic Programming"
    );
  });

  it("gives a problem with no topics an empty list rather than undefined", () => {
    expect(toRecommendation(problem([]), "why").topics).toEqual([]);
  });

  it("carries the fields the client renders", () => {
    const recommendation = toRecommendation(problem(["dp"]), "why");
    expect(recommendation.problemId).toBe("problem-1");
    expect(recommendation.provider).toBe(Provider.CODEFORCES);
    expect(recommendation.difficultyRaw).toBe("1200");
    expect(recommendation.difficultyBand).toBe(DifficultyBand.MEDIUM);
  });
});

describe("primaryTopicName", () => {
  it("names the alphabetically first topic, not the first one stored", () => {
    // A reason string naming a topic must not change between two identical calls.
    expect(primaryTopicName(problem(["trees", "dp", "graphs"]))).toBe("dp");
  });

  it("returns null for a problem with no topics", () => {
    expect(primaryTopicName(problem([]))).toBeNull();
  });
});
