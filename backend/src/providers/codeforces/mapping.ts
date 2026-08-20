import { DifficultyBand, SolveStatus } from "@prisma/client";
import type { CfProblem, CfSubmission } from "./client";

// ONE format, ONE function, EVERY path. @@unique([provider, externalId]) only stops
// duplicates if the catalog sync and the user sync spell a problem identically -
// "1234A" vs "1234-A" would be two different keys and the constraint would catch
// nothing, with the user's solve attached to one row and the engine recommending the
// other.
export function toExternalId(contestId: number, index: string): string {
  return `${contestId}${index}`;
}

// Gym contests are numbered from 100000 and live in a different URL space; the
// problemset URL 404s for them. Only the user-sync path ever sees one, because
// problemset.problems returns no gym problems at all.
const GYM_CONTEST_ID_FLOOR = 100_000;

export function toProblemUrl(contestId: number, index: string): string {
  if (contestId >= GYM_CONTEST_ID_FLOOR) {
    return `https://codeforces.com/gym/${contestId}/problem/${index}`;
  }
  return `https://codeforces.com/problemset/problem/${contestId}/${index}`;
}

export function ratingToBand(rating: number): DifficultyBand {
  if (rating < 1200) return DifficultyBand.EASY;
  if (rating < 1800) return DifficultyBand.MEDIUM;
  return DifficultyBand.HARD;
}

export type ImportableProblem = CfProblem & {
  contestId: number;
  rating: number;
};

export type SkipReason = "unrated" | "no-contest-id";

export function classifyProblem(
  problem: CfProblem
): { importable: true; problem: ImportableProblem } | {
  importable: false;
  reason: SkipReason;
} {
  // No contest id: the ACMSGURU archive carries problemsetName instead. We do NOT
  // fabricate an id - a made-up externalId would collide unpredictably with a real one.
  if (problem.contestId === undefined) {
    return { importable: false, reason: "no-contest-id" };
  }

  // Unrated problems are dropped rather than given an invented band, which is what
  // keeps difficultyRaw and difficultyBand both NOT NULL. Cost: a solve on an unrated
  // problem is lost entirely.
  if (problem.rating === undefined) {
    return { importable: false, reason: "unrated" };
  }

  return {
    importable: true,
    problem: problem as ImportableProblem,
  };
}

// One UserProblem per (user, problem), never one per submission. The rules:
//   status           ANY submission with verdict OK means SOLVED, whatever came before
//                    or after. Reading only the newest submission is the tempting bug.
//   attemptCount     every submission, not just the failures.
//   solvedAt         the EARLIEST OK. lastAttemptedAt the LATEST of any verdict.
// The last two genuinely differ whenever someone resubmits after solving, so a bug
// conflating them passes on most problems.

const ACCEPTED_VERDICT = "OK";

export type AggregatedSolve = {
  externalId: string;
  problem: ImportableProblem;
  status: SolveStatus;
  attemptCount: number;
  solvedAt: Date | null;
  lastAttemptedAt: Date;
};

export type AggregationResult = {
  solves: AggregatedSolve[];
  skippedUnrated: number;
  skippedNoContestId: number;
};

export function aggregateSubmissions(
  submissions: CfSubmission[]
): AggregationResult {
  // Keyed on externalId, the same key the database uniques on, so two submissions to
  // one problem cannot become two rows.
  const byExternalId = new Map<string, AggregatedSolve>();

  let skippedUnrated = 0;
  let skippedNoContestId = 0;

  for (const submission of submissions) {
    const classified = classifyProblem(submission.problem);
    if (!classified.importable) {
      if (classified.reason === "unrated") skippedUnrated++;
      else skippedNoContestId++;
      continue;
    }

    const problem = classified.problem;
    const externalId = toExternalId(problem.contestId, problem.index);

    // An absent verdict (still judging) counts as an attempt but never as a solve.
    const isAccepted = submission.verdict === ACCEPTED_VERDICT;
    const submittedAt = new Date(submission.creationTimeSeconds * 1000);

    const existing = byExternalId.get(externalId);

    if (!existing) {
      byExternalId.set(externalId, {
        externalId,
        problem,
        status: isAccepted ? SolveStatus.SOLVED : SolveStatus.ATTEMPTED,
        attemptCount: 1,
        solvedAt: isAccepted ? submittedAt : null,
        lastAttemptedAt: submittedAt,
      });
      continue;
    }

    existing.attemptCount++;

    // SOLVED is sticky: once any submission was accepted, nothing later can
    // demote the problem back to ATTEMPTED.
    if (isAccepted) {
      existing.status = SolveStatus.SOLVED;
      // Earliest OK wins.
      if (existing.solvedAt === null || submittedAt < existing.solvedAt) {
        existing.solvedAt = submittedAt;
      }
    }

    // Latest submission of any verdict wins.
    if (submittedAt > existing.lastAttemptedAt) {
      existing.lastAttemptedAt = submittedAt;
    }
  }

  // Sorted so two identical runs issue byte-identical writes and a diff between them
  // is meaningful.
  const solves = [...byExternalId.values()].sort((a, b) =>
    a.externalId.localeCompare(b.externalId)
  );

  return { solves, skippedUnrated, skippedNoContestId };
}
