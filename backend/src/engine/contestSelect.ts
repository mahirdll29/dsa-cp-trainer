import { DifficultyBand, SolveStatus } from "@prisma/client";
import prisma from "../lib/prisma";

// Contest selection is NOT the recommendation engine and deliberately shares no code
// with it. The engine ranks by weak topics and due revisions, which is the right answer
// for "what should I work on" and the wrong one for "give me a spread". Teaching the
// engine a contest profile would have been an engine change, and the engine is frozen.

export const DURATION_MINUTES = [60, 90, 120];
export const SIZES = [3, 4, 5, 6];

// What each size produces, as a table rather than branching. "What does size 5 give
// me" should be something you read, not something you trace.
export const SPREAD: Record<number, Record<DifficultyBand, number>> = {
  3: { EASY: 1, MEDIUM: 1, HARD: 1 },
  4: { EASY: 1, MEDIUM: 2, HARD: 1 },
  5: { EASY: 1, MEDIUM: 2, HARD: 2 },
  6: { EASY: 2, MEDIUM: 2, HARD: 2 },
};

// Easiest first, because position IS the running order the contest is played in.
const BAND_ORDER: DifficultyBand[] = [
  DifficultyBand.EASY,
  DifficultyBand.MEDIUM,
  DifficultyBand.HARD,
];

const RECENT_CONTESTS = 3;

export class ContestSelectionError extends Error {
  constructor(
    readonly band: DifficultyBand,
    readonly available: number,
    readonly needed: number
  ) {
    super(
      `Not enough unsolved ${band} problems with topics: ${available} available, ${needed} needed`
    );
    this.name = "ContestSelectionError";
  }
}

export type SelectedProblem = {
  problemId: string;
  position: number;
};

export async function selectContestProblems(
  userId: string,
  size: number
): Promise<SelectedProblem[]> {
  const spread = SPREAD[size];

  const [solved, recent] = await Promise.all([
    prisma.userProblem.findMany({
      where: { userId, status: SolveStatus.SOLVED },
      select: { problemId: true },
    }),
    prisma.contestSession.findMany({
      where: { userId },
      orderBy: { startedAt: "desc" },
      take: RECENT_CONTESTS,
      select: { problems: { select: { problemId: true } } },
    }),
  ]);

  const excluded = [
    ...solved.map((row) => row.problemId),
    ...recent.flatMap((contest) => contest.problems.map((p) => p.problemId)),
  ];

  // An untagged problem in a calibrated set is noise: nothing downstream can say what
  // it was calibrated on.
  const base = {
    problemTopics: { some: {} },
    id: { notIn: excluded },
  };

  // The id list is shipped rather than expressed as `userProblems: { none: ... }`.
  // Measured on the real account, the relation filter costs 2704 ms against 627 ms for
  // a 563-element notIn - the opposite of what the shape suggests.
  const counts = await prisma.problem.groupBy({
    by: ["difficultyBand"],
    where: { ...base, difficultyBand: { in: BAND_ORDER } },
    _count: { _all: true },
  });

  const available = new Map(
    counts.map((row) => [row.difficultyBand, row._count._all])
  );

  const selected: SelectedProblem[] = [];

  for (const band of BAND_ORDER) {
    const needed = spread[band];
    const pool = available.get(band) ?? 0;

    // No substitution from another band: a set that is not the requested spread is not
    // the requested contest.
    if (pool < needed) {
      throw new ContestSelectionError(band, pool, needed);
    }

    for (let taken = 0; taken < needed; taken++) {
      // A random offset into the pool rather than loading it. Fetching every eligible
      // HARD id measured 1125 ms; this is one indexed seek.
      //
      // Plain Math.random(), and deliberately unseeded: the set is written to
      // ContestProblem rows at creation and never recomputed, so there is nothing to
      // reproduce.
      const [problem] = await prisma.problem.findMany({
        where: {
          ...base,
          difficultyBand: band,
          id: { notIn: [...excluded, ...selected.map((s) => s.problemId)] },
        },
        select: { id: true },
        orderBy: { id: "asc" },
        skip: Math.floor(Math.random() * (pool - taken)),
        take: 1,
      });

      // The count above is the same transaction-free read as this one, so a catalog
      // write between them could empty a band we were promised.
      if (!problem) {
        throw new ContestSelectionError(band, pool - taken, needed - taken);
      }

      selected.push({ problemId: problem.id, position: selected.length + 1 });
    }
  }

  return selected;
}
