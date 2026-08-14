import { DifficultyBand, SolveStatus } from "@prisma/client";
import prisma from "../lib/prisma";

// ---------------------------------------------------------------------------
// MASTERY — the most important piece of logic in this project.
//
// NO AI ANYWHERE IN THIS MODULE. The score is arithmetic over the user's own
// solve history. The AI layer (Module 6) will explain a recommendation in
// human language; it will never produce one. The engine has to be correct with
// AI switched off entirely.
// ---------------------------------------------------------------------------

// WHY THE OBVIOUS FORMULA IS WRONG.
//
//     masteryScore = solved / (solved + attempted)
//
// A user solves ONE Trie problem on the first try: 1/1 = 1.0. Perfect mastery
// of Tries, on a single data point. Meanwhile Arrays, where they solved 25 and
// failed 3, scores 25/28 = 0.89. Rank ascending to find weak areas and the
// engine concludes this user is BETTER at Tries than at Arrays — and every
// recommendation downstream inherits that mistake.
//
// The bug is that the formula reports a RATIO when the engine needs a BELIEF.
// A ratio carries no notion of how much evidence produced it: 1/1 and 100/100
// are the same number. So the fix has to add evidence to the arithmetic, in
// two stages.

// STAGE 1 — SMOOTHING. Pretend every topic already contains a few imaginary
// problems, half of them solved. Real data has to outvote that imaginary
// starting point, so a single lucky solve cannot reach 1.0.
//
// The technique is called ADDITIVE (or LAPLACE) SMOOTHING; in the general
// framing it is a BAYESIAN PRIOR, and PRIOR_STRENGTH is the weight of that
// prior measured in problems.
const PRIOR_MEAN = 0.5; // neutral: before any evidence we assume nothing
const PRIOR_STRENGTH = 4; // the imaginary evidence is worth 4 problems

// STAGE 2 — VOLUME. Accuracy alone is not mastery: solving 3 problems in a
// topic and solving 30 are different achievements at identical accuracy. So
// the smoothed rate is blended back toward neutral in proportion to how much
// evidence exists. Below VOLUME_TARGET problems the score is dragged toward
// the middle from whichever side; at or above it, the topic's own record
// stands on its own.
//
// TRADEOFF, STATED: confidence is driven by EVIDENCE, not by SUCCESS. A user
// who has failed 10 problems in a topic is fully "confident" — we are
// confident they are weak, and their score sits well below neutral, which is
// right. The real cost lands on strong users: 3-solved-out-of-3 cannot exceed
// ~0.56 no matter how clean those solves were. Deliberate. The engine would
// rather recommend one problem too many than declare a topic finished on three
// data points.
const VOLUME_TARGET = 10;
const NEUTRAL = 0.5;

// Below this a topic counts as WEAK. Above it, STRONG. A topic with no data at
// all is neither — see getMasteryOverview.
export const WEAK_THRESHOLD = 0.6;

// DIFFICULTY THRESHOLDS — recommend just above current comfort. Too easy is
// boring and teaches nothing; too hard is demoralising and teaches nothing.
//
// These two numbers are OUR JUDGMENT CALL, not a researched standard — exactly
// like the Codeforces rating cutoffs in Module 1. They live here, in one place,
// and changing them needs no migration because the band is derived at read time
// from the stored score.
const EASY_CEILING = 0.45; //   < 0.45        -> EASY
const HARD_FLOOR = 0.7; //      >= 0.70       -> HARD, between the two -> MEDIUM

// A topic we know NOTHING about gets an EASY probe: the cheapest question that
// cannot demoralise, and enough to generate a first signal.
export const EXPLORATORY_BAND: DifficultyBand = DifficultyBand.EASY;

export function masteryToBand(masteryScore: number): DifficultyBand {
  if (masteryScore < EASY_CEILING) return DifficultyBand.EASY;
  if (masteryScore < HARD_FLOOR) return DifficultyBand.MEDIUM;
  return DifficultyBand.HARD;
}

// The formula itself, deliberately a pure function of two numbers: no database,
// no request, no clock. That is what makes it checkable by hand and testable
// without booting a server.
//
// Worked example — Dynamic Programming, 2 solved and 6 attempted-not-solved:
//   naive       = 2 / 8                = 0.250
//   successRate = (2 + 0.5*4) / (8 + 4) = 4 / 12 = 0.3333
//   confidence  = min(1, 8 / 10)                 = 0.8
//   mastery     = 0.5 + (0.3333 - 0.5) * 0.8     = 0.3667
export function calculateMasteryScore(
  solvedCount: number,
  attemptedCount: number
): number {
  const total = solvedCount + attemptedCount;

  // No evidence means no opinion. Callers never store a row in this state —
  // a topic with no data is UNKNOWN, not weak — but the guard keeps the
  // function total rather than dividing by a zero-ish denominator.
  if (total === 0) return NEUTRAL;

  const successRate =
    (solvedCount + PRIOR_MEAN * PRIOR_STRENGTH) / (total + PRIOR_STRENGTH);
  const confidence = Math.min(1, total / VOLUME_TARGET);
  const mastery = NEUTRAL + (successRate - NEUTRAL) * confidence;

  // Rounded to 4 decimal places so the stored value is stable, comparable and
  // checkable by hand. Float arithmetic left raw would put 0.36666666666666664
  // in the database and make two "identical" recomputes look different in a
  // diff.
  return Math.round(Math.min(1, Math.max(0, mastery)) * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// RECOMPUTE — rebuild every TopicMastery row for one user from scratch.
//
// Called by POST /api/mastery/recompute, by the dev seed, and — this is the
// important one — by every importer built in Modules 4 and 5, because
// TopicMastery is stored rather than computed (architecture.md 2.2) and a
// stored derived value silently rots if nobody refreshes it.
//
// Having three callers is precisely why this lives in its own module instead
// of inside a route handler. CLAUDE.md's rule is "no service layer unless the
// logic genuinely has two callers"; auth had one caller per handler and stayed
// in the route file. This clears the bar.
// ---------------------------------------------------------------------------

export async function recomputeMastery(userId: string): Promise<number> {
  // ONE query for the user's whole history, with each problem's topic links
  // pulled along.
  //
  // THE N+1 THIS AVOIDS: fetch the UserProblem rows, then loop and ask "what
  // topics does this problem have?" once per row. Every individual query is
  // fast, which is exactly why nobody notices until there are 2,000 of them.
  // Prisma resolves an `include` on a to-many relation as ONE batched
  // follow-up query (WHERE problemId IN (...)), so this is a fixed 2 round
  // trips regardless of how many problems the user has touched.
  const userProblems = await prisma.userProblem.findMany({
    where: { userId },
    select: {
      status: true,
      problem: {
        select: {
          problemTopics: { select: { topicId: true } },
        },
      },
    },
  });

  // Aggregate in JavaScript rather than a SQL GROUP BY. Readability over
  // cleverness at this size — a user has at most a few thousand rows, and this
  // loop is trivially explainable. The scale answer (push the aggregation into
  // one grouped SQL statement so the rows never cross the wire) is recorded in
  // the interview-prep doc.
  const counts = new Map<string, { solved: number; attempted: number }>();

  for (const userProblem of userProblems) {
    // A problem tagged with 3 topics counts toward all 3. That is intended:
    // solving a hard DP-on-trees problem is evidence about both DP and trees.
    for (const link of userProblem.problem.problemTopics) {
      const entry = counts.get(link.topicId) ?? { solved: 0, attempted: 0 };
      if (userProblem.status === SolveStatus.SOLVED) {
        entry.solved += 1;
      } else {
        entry.attempted += 1;
      }
      counts.set(link.topicId, entry);
    }
  }

  // UPSERT on the (userId, topicId) unique, so running this twice produces the
  // same rows rather than a second set of them. Idempotency is not a nicety
  // here: an importer that retries after a network failure would otherwise
  // double every count.
  for (const [topicId, entry] of counts) {
    const masteryScore = calculateMasteryScore(entry.solved, entry.attempted);

    await prisma.topicMastery.upsert({
      where: { userId_topicId: { userId, topicId } },
      update: {
        solvedCount: entry.solved,
        attemptedCount: entry.attempted,
        masteryScore,
      },
      create: {
        userId,
        topicId,
        solvedCount: entry.solved,
        attemptedCount: entry.attempted,
        masteryScore,
      },
    });
    // lastUpdatedAt is @updatedAt — Prisma sets it on every write, so it is
    // never something a caller can forget.
  }

  // A RECOMPUTE, not a merge: drop rows for topics the user no longer has any
  // data in. Without this, a topic whose UserProblem rows were removed keeps a
  // stale mastery row forever and stays out of the "unknown" bucket it now
  // belongs in.
  //
  // The empty case is branched explicitly rather than passing `notIn: []`,
  // because "not in the empty set" is true for every row and relying on an ORM
  // to translate that the way you assumed is how tables get emptied by
  // accident.
  const topicIdsWithData = [...counts.keys()];
  if (topicIdsWithData.length === 0) {
    await prisma.topicMastery.deleteMany({ where: { userId } });
  } else {
    await prisma.topicMastery.deleteMany({
      where: { userId, topicId: { notIn: topicIdsWithData } },
    });
  }

  return counts.size;
}

// ---------------------------------------------------------------------------
// OVERVIEW — weak / strong / unknown, kept strictly separate.
//
// THE DISTINCTION THAT MATTERS: a topic with NO data is not a weak topic, it
// is an UNKNOWN topic. Those are different states and they need different
// treatment — a weak topic needs practice at a lower difficulty, an unknown
// topic needs one exploratory problem to establish a baseline.
//
// Conflate them and every brand-new user gets 32 fabricated "weaknesses",
// most of which they may be perfectly fine at, drowning out the one topic they
// demonstrably struggle with.
// ---------------------------------------------------------------------------

export type TopicMasteryView = {
  topicId: string;
  name: string;
  slug: string;
  solvedCount: number;
  attemptedCount: number;
  masteryScore: number;
  targetBand: DifficultyBand;
};

export type UnknownTopicView = {
  topicId: string;
  name: string;
  slug: string;
};

export type MasteryOverview = {
  weak: TopicMasteryView[];
  strong: TopicMasteryView[];
  unknown: UnknownTopicView[];
};

export async function getMasteryOverview(
  userId: string
): Promise<MasteryOverview> {
  // Two queries, both fixed cost. Ordering by name here gives the unknown list
  // its deterministic order for free.
  const [topics, masteries] = await Promise.all([
    prisma.topic.findMany({
      select: { id: true, name: true, slug: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
    // THE OWNERSHIP GUARANTEE: userId is in the WHERE clause. There is no
    // fetch-then-check step that a future route could forget.
    prisma.topicMastery.findMany({
      where: { userId },
      select: {
        topicId: true,
        solvedCount: true,
        attemptedCount: true,
        masteryScore: true,
      },
    }),
  ]);

  const masteryByTopicId = new Map(masteries.map((m) => [m.topicId, m]));

  const known: TopicMasteryView[] = [];
  const unknown: UnknownTopicView[] = [];

  for (const topic of topics) {
    const mastery = masteryByTopicId.get(topic.id);

    if (!mastery) {
      unknown.push({ topicId: topic.id, name: topic.name, slug: topic.slug });
      continue;
    }

    known.push({
      topicId: topic.id,
      name: topic.name,
      slug: topic.slug,
      solvedCount: mastery.solvedCount,
      attemptedCount: mastery.attemptedCount,
      masteryScore: mastery.masteryScore,
      targetBand: masteryToBand(mastery.masteryScore),
    });
  }

  // EVERY SORT ENDS IN A UNIQUE TIE-BREAKER. Two topics can easily share a
  // mastery score, and neither JavaScript's sort nor PostgreSQL's row order is
  // guaranteed stable for ties — the same data can come back in a different
  // order after a vacuum or a query-plan change. Comparing topicId last makes
  // the total order provably unique, which is what lets the whole engine be
  // deterministic.
  const weakestFirst = (a: TopicMasteryView, b: TopicMasteryView) =>
    a.masteryScore - b.masteryScore || a.topicId.localeCompare(b.topicId);

  const strongestFirst = (a: TopicMasteryView, b: TopicMasteryView) =>
    b.masteryScore - a.masteryScore || a.topicId.localeCompare(b.topicId);

  return {
    weak: known
      .filter((t) => t.masteryScore < WEAK_THRESHOLD)
      .sort(weakestFirst),
    strong: known
      .filter((t) => t.masteryScore >= WEAK_THRESHOLD)
      .sort(strongestFirst),
    unknown,
  };
}
