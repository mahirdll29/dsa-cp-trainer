import { SolveStatus } from "@prisma/client";
import prisma from "../lib/prisma";

export const REVISION_INTERVALS = [1, 3, 7, 14, 30] as const;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * MILLISECONDS_PER_DAY);
}

// Capped at the last rung so the ladder never runs off the end of the array.
function intervalForRepetition(repetitionCount: number): number {
  const index = Math.min(repetitionCount, REVISION_INTERVALS.length - 1);
  return REVISION_INTERVALS[index];
}

export async function scheduleRevisionForSolve(
  userId: string,
  problemId: string,
  now: Date = new Date()
) {
  return prisma.revisionItem.upsert({
    where: { userId_problemId: { userId, problemId } },
    // Empty update on purpose: an existing item means the user is partway up the ladder,
    // and a re-run import must not knock them back to day one.
    update: {},
    create: {
      userId,
      problemId,
      repetitionCount: 0,
      intervalDays: intervalForRepetition(0),
      dueAt: addDays(now, intervalForRepetition(0)),
    },
  });
}

// Ensures every solved problem has a revision item. Both importers call this after
// writing their UserProblem rows.
export async function syncRevisionSchedule(
  userId: string,
  now: Date = new Date()
): Promise<number> {
  const [solved, existing] = await Promise.all([
    prisma.userProblem.findMany({
      where: { userId, status: SolveStatus.SOLVED },
      select: { problemId: true },
      orderBy: { problemId: "asc" },
    }),
    prisma.revisionItem.findMany({
      where: { userId },
      select: { problemId: true },
    }),
  ]);

  const alreadyScheduled = new Set(existing.map((item) => item.problemId));
  const missing = solved
    .map((row) => row.problemId)
    .filter((problemId) => !alreadyScheduled.has(problemId));

  if (missing.length === 0) return 0;

  const result = await prisma.revisionItem.createMany({
    data: missing.map((problemId) => ({
      userId,
      problemId,
      repetitionCount: 0,
      intervalDays: intervalForRepetition(0),
      dueAt: addDays(now, intervalForRepetition(0)),
    })),
    // The unique constraint is the real guard against a concurrent insert; this only
    // stops it becoming a 500.
    skipDuplicates: true,
  });

  return result.count;
}

// `limit` exists because buildRecommendations only ever uses the first three, while
// GET /api/revision/due legitimately wants them all. Without it the engine pulls every
// due item for the user, each with its problem and topic links, to discard all but 3.
export async function getDueRevisions(
  userId: string,
  now: Date = new Date(),
  limit?: number
) {
  return prisma.revisionItem.findMany({
    // userId is IN the where clause - the scoping is the query, not a check after it.
    where: { userId, dueAt: { lte: now } },
    include: {
      problem: {
        select: {
          id: true,
          title: true,
          url: true,
          provider: true,
          difficultyRaw: true,
          difficultyBand: true,
          // Pulled along so a caller can label an item with its topics without a query per row.
          problemTopics: { select: { topic: { select: { name: true } } } },
        },
      },
    },
    // problemId breaks ties so items sharing a dueAt never come back in arbitrary order.
    orderBy: [{ dueAt: "asc" }, { problemId: "asc" }],
    take: limit,
  });
}

// Returns null when the user has no such item, which the route turns into a 404. The
// lookup is on the compound { userId, problemId } unique, so another user's item does
// not match and there is no ownership branch to forget.
export async function reviewRevisionItem(
  userId: string,
  problemId: string,
  now: Date = new Date()
) {
  const item = await prisma.revisionItem.findUnique({
    where: { userId_problemId: { userId, problemId } },
  });

  if (!item) return null;

  const nextRepetition = item.repetitionCount + 1;
  const nextInterval = intervalForRepetition(nextRepetition);

  return prisma.revisionItem.update({
    where: { userId_problemId: { userId, problemId } },
    data: {
      repetitionCount: nextRepetition,
      intervalDays: nextInterval,
      // Counted from NOW, not from the old dueAt: a user reviewing late has just proved they
      // still remember it after the longer gap.
      dueAt: addDays(now, nextInterval),
      lastReviewedAt: now,
    },
    include: {
      problem: {
        select: {
          id: true,
          title: true,
          url: true,
          provider: true,
          difficultyRaw: true,
          difficultyBand: true,
        },
      },
    },
  });
}
