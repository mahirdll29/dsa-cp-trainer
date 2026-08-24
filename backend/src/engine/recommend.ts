import { DifficultyBand, Provider, SolveStatus } from "@prisma/client";
import prisma from "../lib/prisma";
import {
  EXPLORATORY_BAND,
  getMasteryOverview,
  TopicMasteryView,
  UnknownTopicView,
} from "./mastery";
import { getDueRevisions } from "./revision";

const MAX_RECOMMENDATIONS = 12;

// No single topic may monopolise the list: twelve DP problems in a row is a closed tab.
const MAX_PER_TOPIC = 2;

const MAX_REVISIONS = 3;
const MAX_UNFINISHED = 2;
const WEAK_TOPICS_USED = 3;
const MAX_EXPLORATORY = 2;

// The per-stage caps deliberately sum to 13 against a total of 12. Stages run in
// priority order and each takes only what is left, so an underfilled stage hands its
// slack forward. At exactly 12 a full revision queue would starve stage 4 permanently.

export type Recommendation = {
  problemId: string;
  title: string;
  url: string;
  provider: Provider;
  difficultyRaw: string;
  difficultyBand: DifficultyBand;
  topics: string[];
  // Machine-generated, one of six fixed shapes. Always shown to the user.
  reason: string;
};

type ProblemWithTopics = {
  id: string;
  title: string;
  url: string;
  provider: Provider;
  difficultyRaw: string;
  difficultyBand: DifficultyBand;
  problemTopics: { topic: { name: string } }[];
};

export function toRecommendation(
  problem: ProblemWithTopics,
  reason: string
): Recommendation {
  return {
    problemId: problem.id,
    title: problem.title,
    url: problem.url,
    provider: problem.provider,
    difficultyRaw: problem.difficultyRaw,
    difficultyBand: problem.difficultyBand,
    // Sorted so the same problem always renders its topics in the same order.
    topics: problem.problemTopics.map((link) => link.topic.name).sort(),
    reason,
  };
}

// Alphabetically first, so a reason naming a topic never changes between calls.
export function primaryTopicName(problem: ProblemWithTopics): string | null {
  const names = problem.problemTopics.map((link) => link.topic.name).sort();
  return names[0] ?? null;
}

// Never recommend something already SOLVED, enforced in the WHERE clause rather than by
// filtering afterwards - a row the database never returns cannot be reinstated by a
// later refactor that drops a filter. ATTEMPTED stays eligible: it is stage 2's input.
// `take` over-fetches because earlier stages may already have claimed some candidates.
async function candidateProblemsForTopic(
  userId: string,
  topicId: string,
  difficultyBand: DifficultyBand,
  limit: number
): Promise<ProblemWithTopics[]> {
  return prisma.problem.findMany({
    where: {
      difficultyBand,
      problemTopics: { some: { topicId } },
      userProblems: { none: { userId, status: SolveStatus.SOLVED } },
    },
    select: {
      id: true,
      title: true,
      url: true,
      provider: true,
      difficultyRaw: true,
      difficultyBand: true,
      // One batched follow-up query for every problem's topics, not one query per problem.
      problemTopics: { select: { topic: { select: { name: true } } } },
    },
    // id is the unique tie-breaker. Without it Postgres may return equally-ranked rows in
    // a different order between two identical requests.
    orderBy: { id: "asc" },
    take: limit,
  });
}

// One indexed query per topic, rather than one 200-row pool bucketed by topic.
//
// The pool version looked cheaper and was quietly wrong. Problem.id is a cuid(), which
// is roughly insertion-ordered, so `orderBy: { id: "asc" }, take: 200` is not a sample
// of the catalog - it is a contiguous slice of whatever was imported first. Measured
// against the live database: all 200 rows were CODEFORCES, covering 16 of 32 topics. A
// new user still got a full 12 recommendations, so nothing looked broken, but the 11
// topics only LeetCode covers could never appear - Arrays among them.
//
// Cost: one round trip per topic until the cap, measured ~3.3 s for 12. Every topic has
// EASY coverage, so the walk stops at MAX_RECOMMENDATIONS rather than scanning all 32.
// This runs once in a user's lifetime.
async function coldStartRecommendations(
  userId: string,
  topics: UnknownTopicView[]
): Promise<Recommendation[]> {
  const recommendations: Recommendation[] = [];
  const used = new Set<string>();

  // `topics` arrives ordered by name and each query orders by id, so this is deterministic.
  for (const topic of topics) {
    if (recommendations.length >= MAX_RECOMMENDATIONS) break;

    // A small over-fetch: an earlier topic may already have taken a problem that carries
    // this topic too. Three is plenty - all three would have to be claimed already, and
    // the cost of that is one fewer recommendation, not a wrong one.
    const candidates = await candidateProblemsForTopic(
      userId,
      topic.topicId,
      EXPLORATORY_BAND,
      3
    );

    const candidate = candidates.find((problem) => !used.has(problem.id));
    if (!candidate) continue;

    used.add(candidate.id);
    recommendations.push(
      toRecommendation(candidate, `starting point: ${topic.name}`)
    );
  }

  return recommendations;
}


export async function buildRecommendations(
  userId: string,
  now: Date = new Date()
): Promise<Recommendation[]> {
  const overview = await getMasteryOverview(userId);

  // Counting UserProblem rows is the honest test of "has this user done anything at all".
  // Mastery rows are derived and may be stale or not yet recomputed.
  const historyCount = await prisma.userProblem.count({ where: { userId } });
  if (historyCount === 0) {
    return coldStartRecommendations(userId, overview.unknown);
  }

  const recommendations: Recommendation[] = [];
  const used = new Set<string>();

  const remaining = () => MAX_RECOMMENDATIONS - recommendations.length;
  const add = (problem: ProblemWithTopics, reason: string) => {
    if (used.has(problem.id)) return;
    used.add(problem.id);
    recommendations.push(toRecommendation(problem, reason));
  };

  // Stage 1: due revisions. The one stage that recommends already-solved problems,
  // because a revision item IS a solved problem - which is why the exclusion rule is
  // scoped to the other stages rather than being violated here.
  const dueRevisions = await getDueRevisions(userId, now, MAX_REVISIONS);
  for (const item of dueRevisions) {
    if (remaining() <= 0) break;
    add(item.problem, "due for revision");
  }

  // Stage 2: unfinished attempts - a known gap the user already has context on, ordered
  // by attemptCount descending.
  if (remaining() > 0) {
    const unfinished = await prisma.userProblem.findMany({
      where: { userId, status: SolveStatus.ATTEMPTED },
      select: {
        problem: {
          select: {
            id: true,
            title: true,
            url: true,
            provider: true,
            difficultyRaw: true,
            difficultyBand: true,
            problemTopics: { select: { topic: { select: { name: true } } } },
          },
        },
      },
      orderBy: [{ attemptCount: "desc" }, { problemId: "asc" }],
      take: MAX_UNFINISHED,
    });

    for (const row of unfinished) {
      if (remaining() <= 0) break;
      const topicName = primaryTopicName(row.problem);
      add(
        row.problem,
        topicName ? `unfinished attempt in ${topicName}` : "unfinished attempt"
      );
    }
  }

  // Stage 3: the three weakest topics with data, at their target band.
  const weakTopics = overview.weak.slice(0, WEAK_TOPICS_USED);
  for (const topic of weakTopics) {
    if (remaining() <= 0) break;

    const candidates = await candidateProblemsForTopic(
      userId,
      topic.topicId,
      topic.targetBand,
      MAX_PER_TOPIC + MAX_RECOMMENDATIONS
    );

    let takenFromThisTopic = 0;
    for (const problem of candidates) {
      if (takenFromThisTopic >= MAX_PER_TOPIC || remaining() <= 0) break;
      if (used.has(problem.id)) continue;

      add(problem, `weak in ${topic.name}`);
      takenFromThisTopic += 1;
    }
    // No fallback to another band. The band IS the recommendation, and handing a struggling
    // user a HARD problem because no EASY one was left is worse than one fewer suggestion.
  }

  // Stage 4: one probe per unknown topic. Not a weakness - we have no evidence either
  // way - so it earns a probe, not a course of study.
  const exploratoryTopics = overview.unknown.slice(0, MAX_EXPLORATORY);
  for (const topic of exploratoryTopics) {
    if (remaining() <= 0) break;

    const candidates = await candidateProblemsForTopic(
      userId,
      topic.topicId,
      EXPLORATORY_BAND,
      1 + MAX_RECOMMENDATIONS
    );

    const candidate = candidates.find((problem) => !used.has(problem.id));
    if (candidate) add(candidate, `new topic: ${topic.name}`);
  }

  // The stages already respect the cap; this slice is a final guard, not the mechanism.
  return recommendations.slice(0, MAX_RECOMMENDATIONS);
}
