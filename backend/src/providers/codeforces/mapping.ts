import { DifficultyBand, SolveStatus } from "@prisma/client";
import type { CfProblem, CfSubmission } from "./client";

// ---------------------------------------------------------------------------
// PURE TRANSFORMS. No Prisma, no network, no clock, no console.
//
// Everything in this file is a function of its arguments, which is the same
// property that makes engine/mastery.ts's calculateMasteryScore checkable by
// hand. The interesting logic of an importer is the mapping, and mapping bugs
// are the ones that quietly corrupt a database — so it is worth being able to
// verify these without booting a server or touching Neon.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// EXTERNAL ID — "1234A"
//
// ONE FORMAT, ONE FUNCTION, EVERY PATH. This is the single most dangerous thing
// in the module to get inconsistent.
//
// Problem carries @@unique([provider, externalId]). That constraint only stops
// duplicates if both import paths — the global catalog sync and the per-user
// submission sync — spell the same problem the same way. If the catalog wrote
// "1234A" and the user sync wrote "1234-A", Postgres would see two DIFFERENT
// keys, happily insert both, and the unique constraint would catch nothing. The
// user's solve would attach to one row while the engine recommended the other.
//
// The defence is that there is exactly one function that builds this string and
// both callers use it. Verified against the live problemset: this format
// produces zero collisions across all 11,356 problems.
// ---------------------------------------------------------------------------
export function toExternalId(contestId: number, index: string): string {
  return `${contestId}${index}`;
}

// Codeforces splits its archive across two URL spaces, and the problemset URL
// simply 404s for a gym problem.
//
// Gym contests are numbered from 100000. Verified against real data:
// problemset.problems contains ZERO contestIds >= 100000, but user.status
// definitely does — 533 of one profiled account's 1,919 submissions were gym.
// So this branch is only ever exercised by the user-sync path, which is exactly
// why it would have been easy to miss by testing the catalog alone.
const GYM_CONTEST_ID_FLOOR = 100_000;

export function toProblemUrl(contestId: number, index: string): string {
  if (contestId >= GYM_CONTEST_ID_FLOOR) {
    return `https://codeforces.com/gym/${contestId}/problem/${index}`;
  }
  return `https://codeforces.com/problemset/problem/${contestId}/${index}`;
}

// ---------------------------------------------------------------------------
// DIFFICULTY — the two-column design from architecture.md 2.2.
//
// LeetCode grades Easy/Medium/Hard; Codeforces grades 800-3500. The engine has
// to rank both in one list and cannot compare a word to an integer, so we store
// the provider's own value verbatim in difficultyRaw (display only) and a
// normalized band in difficultyBand (engine only).
//
// THE CONVERSION HAPPENS EXACTLY ONCE, HERE, AT IMPORT. That is the whole point
// of the design: if the engine converted at read time it would branch on
// provider at every comparison, and if we stored only the band we could never
// display "1600" or re-tune the cutoffs without re-importing.
//
// The cutoffs are OUR JUDGMENT CALL, not a Codeforces standard — chosen so
// MEDIUM covers the Div. 2 B/C range where most learners sit. Because
// difficultyRaw is preserved, changing them later is a backfill over existing
// rows, not a re-import.
// ---------------------------------------------------------------------------
export function ratingToBand(rating: number): DifficultyBand {
  if (rating < 1200) return DifficultyBand.EASY;
  if (rating < 1800) return DifficultyBand.MEDIUM;
  return DifficultyBand.HARD;
}

// ---------------------------------------------------------------------------
// IMPORTABILITY — one place that decides whether a problem can be stored.
//
// Both reasons produce a NARROWED type, so TypeScript forces every caller past
// this gate before it can read contestId or rating. That is deliberate: it is
// the difference between "we remembered to check" and "we cannot forget to
// check".
// ---------------------------------------------------------------------------

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
  // NO CONTEST ID: the ACMSGURU archive carries problemsetName instead. We do
  // NOT fabricate an id — a made-up externalId would collide unpredictably with
  // a real one and there is no way to recover the true identity later.
  //
  // Verified unreachable in practice: the default problemset call returns none
  // of these, and all 453 that exist are unrated, so the rule below would catch
  // them anyway. Kept because the API is untrusted input and a cheap branch is
  // better than an assumption.
  if (problem.contestId === undefined) {
    return { importable: false, reason: "no-contest-id" };
  }

  // UNRATED: architecture.md 2.6 decision 4. A large share of the problemset
  // carries no rating, and rather than invent a band for them or make the
  // columns nullable, the importer drops them — which is what keeps
  // difficultyRaw and difficultyBand both NOT NULL.
  //
  // ACCEPTED COST, restated because it is a real one: a user who solved an
  // unrated problem loses that solve entirely.
  if (problem.rating === undefined) {
    return { importable: false, reason: "unrated" };
  }

  return {
    importable: true,
    problem: problem as ImportableProblem,
  };
}

// ---------------------------------------------------------------------------
// VERDICT AGGREGATION — the heart of the user import.
//
// architecture.md 2.2: we store DERIVED STATE, not raw submission history. One
// UserProblem row per (user, problem), NEVER one per submission. A user with
// 942 submissions produces 543 rows, not 942.
//
// The rules, and each one is a decision:
//
//   status        ANY submission with verdict "OK" means SOLVED, regardless of
//                 how many failures came before or after it. Solving a problem
//                 on the tenth try is still solving it. Reading only the newest
//                 submission would be the natural-looking bug here, and it gets
//                 the answer wrong for anyone who resubmits after solving.
//
//   attemptCount  EVERY submission for that problem, not just the failures.
//                 This is the engine's proxy for "how much did they struggle",
//                 used to rank unfinished work in recommend.ts stage 2.
//
//   solvedAt      The EARLIEST OK, not the latest. "When did you solve this"
//                 is answered by the first success; later resubmissions are
//                 optimisation, not solving.
//
//   lastAttemptedAt  The LATEST submission of any verdict.
//
// solvedAt and lastAttemptedAt genuinely differ whenever someone resubmits
// after an accepted solution, which is common — so a bug that conflates them
// passes on most problems and fails on those.
//
// Aggregating IN MEMORY, in one pass, before writing anything is also what
// makes the whole import a fixed, small number of database round trips instead
// of one per submission.
// ---------------------------------------------------------------------------

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
  // Keyed by externalId — the same key the database uniques on, so two
  // submissions to the same problem cannot become two rows.
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

    // An absent verdict (still being judged) counts as an attempt but can never
    // count as a solve — the comparison against a string literal handles that
    // without a special case.
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

  // Sorted by externalId so batches are built in a deterministic order. Two
  // identical runs then issue byte-identical writes, which makes a diff between
  // two runs meaningful — the same reasoning that puts a unique tie-breaker on
  // every sort in the recommendation engine.
  const solves = [...byExternalId.values()].sort((a, b) =>
    a.externalId.localeCompare(b.externalId)
  );

  return { solves, skippedUnrated, skippedNoContestId };
}
