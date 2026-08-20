import { DifficultyBand, Prisma, SolveStatus } from "@prisma/client";
import prisma from "../lib/prisma";

const PRIOR_MEAN = 0.5; // neutral: before any evidence we assume nothing
const PRIOR_STRENGTH = 4; // the imaginary evidence is worth 4 problems

const VOLUME_TARGET = 10;
const NEUTRAL = 0.5;

// Below this a topic is WEAK, at or above it STRONG. No row at all is UNKNOWN.
export const WEAK_THRESHOLD = 0.6;

// Recommend just above current comfort. These cutoffs are a judgment call, not a
// standard; the band is derived at read time, so re-tuning them needs no migration.
const EASY_CEILING = 0.45; //   < 0.45        -> EASY
const HARD_FLOOR = 0.7; //      >= 0.70       -> HARD, between the two -> MEDIUM

// A topic we know nothing about gets an EASY probe: enough to produce a first signal.
export const EXPLORATORY_BAND: DifficultyBand = DifficultyBand.EASY;

function masteryToBand(masteryScore: number): DifficultyBand {
  if (masteryScore < EASY_CEILING) return DifficultyBand.EASY;
  if (masteryScore < HARD_FLOOR) return DifficultyBand.MEDIUM;
  return DifficultyBand.HARD;
}

export function calculateMasteryScore(
  solvedCount: number,
  attemptedCount: number
): number {
  const total = solvedCount + attemptedCount;

  // Keeps the function total. Callers never store a row in this state.
  if (total === 0) return NEUTRAL;

  const successRate =
    (solvedCount + PRIOR_MEAN * PRIOR_STRENGTH) / (total + PRIOR_STRENGTH);
  const confidence = Math.min(1, total / VOLUME_TARGET);
  const mastery = NEUTRAL + (successRate - NEUTRAL) * confidence;

  // Rounded before storage: raw floats put 0.36666666666666664 in the database and
  // make two identical recomputes differ in a diff.
  return Math.round(Math.min(1, Math.max(0, mastery)) * 10000) / 10000;
}

export async function recomputeMastery(userId: string): Promise<number> {
  // The include resolves to one batched follow-up query. Rewriting this as a loop over
  // userProblems reintroduces an N+1 that only becomes visible at a few thousand rows.
  //
  // The second read is what MasteryLog diffs against. TopicMastery is the authoritative
  // current state; reading the log to decide what to write to the log would be circular.
  const [userProblems, previousMasteries, existingLog] = await Promise.all([
    prisma.userProblem.findMany({
      where: { userId },
      select: {
        status: true,
        problem: {
          select: {
            problemTopics: { select: { topicId: true } },
          },
        },
      },
    }),
    prisma.topicMastery.findMany({
      where: { userId },
      select: {
        topicId: true,
        solvedCount: true,
        attemptedCount: true,
        masteryScore: true,
      },
    }),
    // Does this user have ANY history yet? A user who predates this table already has
    // TopicMastery rows matching what the recompute produces, so the diff alone would
    // never give them an origin point and their chart would start at its SECOND state.
    // One indexed lookup on the composite. Cost: it is paid on every recompute forever
    // to answer a question that is only interesting once per user.
    prisma.masteryLog.findFirst({ where: { userId }, select: { id: true } }),
  ]);

  const previousByTopicId = new Map(previousMasteries.map((m) => [m.topicId, m]));
  const hasHistory = existingLog !== null;

  const counts = new Map<string, { solved: number; attempted: number }>();

  for (const userProblem of userProblems) {
    // A problem tagged with 3 topics counts toward all 3. Intended, not double counting.
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

  const logRows: Prisma.MasteryLogCreateManyInput[] = [];

  // Upsert on the (userId, topicId) unique: a retried import must not double every count.
  for (const [topicId, entry] of counts) {
    const masteryScore = calculateMasteryScore(entry.solved, entry.attempted);

    // Append only on a real change, so five syncs in a day do not write five identical
    // rows per topic. masteryScore is compared as well as the counts because re-tuning
    // PRIOR_STRENGTH or VOLUME_TARGET moves it at identical counts.
    //
    // A user with no history yet is logged in full: that is the baseline, and it is the
    // origin point every trajectory needs. Because the flag is derived from the log
    // rather than from a timestamp, a baseline whose insert failed is simply retried on
    // the next recompute instead of being lost.
    const previous = previousByTopicId.get(topicId);
    if (
      !hasHistory ||
      !previous ||
      previous.solvedCount !== entry.solved ||
      previous.attemptedCount !== entry.attempted ||
      previous.masteryScore !== masteryScore
    ) {
      logRows.push({
        userId,
        topicId,
        solvedCount: entry.solved,
        attemptedCount: entry.attempted,
        masteryScore,
      });
    }

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
  }

  // A full rebuild, not a merge: a topic with no data left must lose its row and return
  // to the UNKNOWN bucket. The empty case is branched explicitly because `notIn: []` is
  // vacuously true for every row and would delete all of them.
  const topicIdsWithData = [...counts.keys()];
  if (topicIdsWithData.length === 0) {
    await prisma.topicMastery.deleteMany({ where: { userId } });
  } else {
    await prisma.topicMastery.deleteMany({
      where: { userId, topicId: { notIn: topicIdsWithData } },
    });
  }

  // Topics deleted just above get no terminal row: calculateMasteryScore(0, 0) is the
  // NEUTRAL prior, so a zero row would plot as a rise to average mastery for a user who
  // just lost all their evidence. No data is not a score - the same rule as the UNKNOWN
  // bucket. Module 11 reads the drop-off from the gap in capturedAt.
  await appendMasteryLog(logRows);

  return counts.size;
}

// Analytics for Module 11, with no readers yet, so a failure here must not fail a sync
// whose staleness is correctness-critical. Cost: the data point is lost for good - the
// next recompute diffs against a TopicMastery that is already current and sees nothing.
// Capped at one row per topic, far inside Postgres' bind-parameter limit, so no chunking.
async function appendMasteryLog(
  rows: Prisma.MasteryLogCreateManyInput[]
): Promise<void> {
  if (rows.length === 0) return;

  try {
    await prisma.masteryLog.createMany({ data: rows });
  } catch (error) {
    console.error("[masteryLog] append failed, recompute continuing:", error);
  }
}

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
  const [topics, masteries] = await Promise.all([
    prisma.topic.findMany({
      select: { id: true, name: true, slug: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
    // userId is IN the where clause - the scoping is the query, not a check after it.
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

  // Ties break on topicId. Neither Array.sort nor Postgres row order is stable for equal
  // keys, so without this the same data can come back in a different order.
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
