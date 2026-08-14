import { SolveStatus } from "@prisma/client";
import prisma from "../lib/prisma";

// ---------------------------------------------------------------------------
// SPACED REPETITION
//
// THE SPACING EFFECT, in one sentence: reviewing something just BEFORE you
// would have forgotten it is what moves it into long-term memory. Review too
// soon and you are recalling something still fresh, which teaches you nothing
// and wastes the session; review too late and you are not reviewing at all,
// you are relearning from scratch. So every successful review earns a longer
// gap than the last one.
//
// The ladder below is the schedule that implements that: 1 day after solving,
// then 3, then 7, then 14, then 30 — and 30 from then on.
// ---------------------------------------------------------------------------

export const REVISION_INTERVALS = [1, 3, 7, 14, 30] as const;

// WHAT REAL SM-2 HAS THAT THIS DOES NOT — a deliberate scope decision, not an
// omission.
//
// SuperMemo's SM-2 asks the user to rate each review 0-5 ("how easily did you
// recall this?") and feeds that rating into a per-item EASE FACTOR. A card the
// user keeps fumbling gets a lower ease factor and stays on short intervals; a
// card they find trivial accelerates away. The whole adaptiveness of SM-2 lives
// in that one user-supplied number.
//
// We do not collect it. There is no UI for it, and there is no honest way to
// infer it from "the user solved this problem" — attempt count measures the
// original struggle, not recall quality weeks later. Deriving an ease factor
// from data we do not have would be fiction dressed up as an algorithm, and it
// would produce confidently wrong schedules.
//
// So: fixed intervals, identical for every problem and every user. The cost is
// real — a problem the user finds genuinely hard gets the same 30-day gap as
// one they find trivial. The upgrade path is cheap because `intervalDays` and
// `repetitionCount` are already stored per item: adding an ease factor later is
// one column and a changed formula, not a redesign.

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * MILLISECONDS_PER_DAY);
}

// The interval earned after `repetitionCount` completed reviews, capped at the
// last rung so the ladder never runs off the end of the array.
function intervalForRepetition(repetitionCount: number): number {
  const index = Math.min(repetitionCount, REVISION_INTERVALS.length - 1);
  return REVISION_INTERVALS[index];
}

// ---------------------------------------------------------------------------
// SCHEDULING
// ---------------------------------------------------------------------------

// Called when a problem becomes SOLVED. Today that is the dev seed and the
// recompute endpoint; from Module 4 onward it is the importers, which is the
// real caller this is written for.
export async function scheduleRevisionForSolve(
  userId: string,
  problemId: string,
  now: Date = new Date()
) {
  return prisma.revisionItem.upsert({
    where: { userId_problemId: { userId, problemId } },
    // EMPTY UPDATE ON PURPOSE. If an item already exists, the user is partway
    // up the ladder and re-running an import must not knock them back to day
    // one. Upsert-with-no-update is "create if absent, otherwise leave alone",
    // which is what makes repeated imports safe.
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

// Ensure every solved problem has a revision item. This is what an importer
// will call after writing its UserProblem rows, and it is why the recompute
// endpoint calls it too — otherwise nothing would ever create these rows until
// Module 4 lands, and the scheduler would be dead code we could not verify.
export async function syncRevisionSchedule(
  userId: string,
  now: Date = new Date()
): Promise<number> {
  // Two set-based queries and a diff, rather than a per-problem existence
  // check inside a loop (which would be the N+1 version of this function).
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
    // Belt and braces against a concurrent call inserting the same row between
    // our read and our write — the same read-then-write race the auth module
    // documented. The unique constraint is the actual guarantee; this just
    // stops it becoming a 500.
    skipDuplicates: true,
  });

  return result.count;
}

// ---------------------------------------------------------------------------
// READING AND ADVANCING
// ---------------------------------------------------------------------------

export async function getDueRevisions(userId: string, now: Date = new Date()) {
  return prisma.revisionItem.findMany({
    // userId is IN the where clause — the ownership scoping is the query
    // itself, not a check performed after fetching.
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
          // Pulled along so a caller can label the item with its topics
          // without a follow-up query per row. Two round trips total, not
          // 1 + N — Prisma batches this into one WHERE problemId IN (...).
          problemTopics: { select: { topic: { select: { name: true } } } },
        },
      },
    },
    // Most overdue first, then problemId as the unique tie-breaker so items
    // sharing a dueAt never come back in an arbitrary order.
    orderBy: [{ dueAt: "asc" }, { problemId: "asc" }],
  });
}

// Advance one item up the ladder. Returns null when the user has no such item,
// which the route turns into a 404.
//
// NOTE THE LOOKUP: it matches on the compound { userId, problemId } unique. A
// problemId belonging to somebody else's revision item simply does not match,
// so there is no ownership branch to write and none to forget.
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
      // Counted from NOW, not from the old dueAt. A user reviewing three days
      // late has just proved they still remember it after the longer gap, so
      // restarting the clock from the review is both simpler and kinder than
      // punishing them for being late.
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
