import { DifficultyBand } from "@prisma/client";
import type { LcDifficulty } from "./client";

// ---------------------------------------------------------------------------
// PURE TRANSFORMS. No Prisma, no network, no clock, no console.
//
// Same discipline as providers/codeforces/mapping.ts: the interesting logic of
// an importer is the mapping, and mapping bugs are the ones that quietly
// corrupt a database. Everything here is a function of its arguments, so it can
// be checked by hand without booting a server or touching Neon.
//
// This file is MUCH SMALLER than its Codeforces counterpart, and that is the
// finding rather than an omission — see the difficulty note below.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// EXTERNAL ID — the title slug, e.g. "two-sum"
//
// ONE FORMAT, ONE FUNCTION, EVERY PATH — Module 4 decision 38, and the reason
// is unchanged. Problem carries @@unique([provider, externalId]), and that
// constraint only prevents duplicates if BOTH import paths spell a problem
// identically. The catalog sync and the user sync both call this.
//
// WHY titleSlug AND NOT questionFrontendId:
//   - it is stable, and it IS the URL (leetcode.com/problems/<slug>/)
//   - questionFrontendId renumbers, and does not appear in any URL
//   - verified against the live catalog: 4,019 problems, 4,019 distinct slugs,
//     ZERO collisions
//
// It is a pass-through today. It exists as a function anyway so that if the id
// scheme ever needs normalising (case, a prefix), there is exactly one place to
// do it and both paths inherit the change — the alternative is discovering
// later that two call sites disagree.
// ---------------------------------------------------------------------------
export function toExternalId(titleSlug: string): string {
  return titleSlug;
}

// The canonical problem URL.
//
// DELIBERATELY BUILT, NOT TAKEN FROM THE API. /select returns a `link` field
// ("https://leetcode.com/problems/two-sum" — note: no trailing slash), but
// /problems returns no link at all. Using the API's value where it exists and
// building one where it does not would give the two import paths DIFFERENT URL
// strings for the same problem, and `url` is a column we compare on when
// deciding whether a row changed — so every sync would flap those rows back and
// forth forever. One construction rule, both paths, trailing slash included.
export function toProblemUrl(titleSlug: string): string {
  return `https://leetcode.com/problems/${titleSlug}/`;
}

// ---------------------------------------------------------------------------
// DIFFICULTY — and this is the two-column design from architecture.md 2.2
// vindicated in the most direct way available.
//
// Codeforces grades 800-3500, so Module 4 had to INVENT cutoffs (<1200 EASY,
// <1800 MEDIUM, else HARD) and defend them as a judgment call that nobody
// standardised and that reasonable people would place elsewhere.
//
// LeetCode already grades Easy/Medium/Hard. This function is a one-to-one map
// with NO judgment in it at all.
//
// SAME TWO COLUMNS, ONE PROVIDER WHERE IT WAS HARD AND ONE WHERE IT WAS
// TRIVIAL. That contrast IS the argument for the design: difficultyRaw keeps
// each provider's own truth for display ("1600" / "Medium"), difficultyBand
// gives the engine one comparable scale, and the conversion happens once, at
// import, in the provider module. Had we stored only a band we could never
// display "1600"; had we stored only the raw value the engine would branch on
// provider at every comparison.
//
// The parameter type is the narrowed LcDifficulty union rather than `string`,
// so there is no unreachable default branch to write and no way for an
// unrecognised grade to reach this function — client.ts rejected it already.
// ---------------------------------------------------------------------------
export function difficultyToBand(difficulty: LcDifficulty): DifficultyBand {
  switch (difficulty) {
    case "Easy":
      return DifficultyBand.EASY;
    case "Medium":
      return DifficultyBand.MEDIUM;
    case "Hard":
      return DifficultyBand.HARD;
  }
}

// ---------------------------------------------------------------------------
// SUBMISSION AGGREGATION — deliberately far simpler than Codeforces'.
//
// providers/codeforces/mapping.ts has a 70-line aggregateSubmissions that
// works out SOLVED vs ATTEMPTED, counts every attempt, takes the EARLIEST
// accepted submission for solvedAt and the LATEST of any verdict for
// lastAttemptedAt. None of that is possible here, and the reason is the API,
// not our effort:
//
//   status         /acSubmission returns ACCEPTED SUBMISSIONS ONLY. Every row
//                  is a solve. There is nothing to decide.
//
//   attemptCount   ALWAYS 1. The endpoint carries no failure information, so
//                  the true count is unknowable. We store 1 rather than
//                  fabricating a plausible number — a made-up attempt count
//                  would feed straight into the engine's "how much did they
//                  struggle" ranking (engine/recommend.ts stage 2) and produce
//                  confidently wrong recommendations.
//
//   solvedAt       The submission timestamp.
//   lastAttemptedAt  The same value, because we know of no later attempt.
//
// THE ONE THING STILL WORTH DOING HERE: de-duplicate by slug. The 20-row
// window can in principle contain two accepted submissions for the same problem
// (a resubmission), and UserProblem is one row per (user, problem), never one
// per submission (architecture.md 2.2). Keying the map on externalId — the same
// key the database uniques on — makes that structurally impossible rather than
// merely unlikely.
//
// EARLIEST accepted wins for solvedAt, matching Module 4's rule: "when did you
// solve this" is answered by the first success, not by a later resubmission.
// ---------------------------------------------------------------------------

export type AggregatedSolve = {
  externalId: string;
  titleSlug: string;
  title: string;
  solvedAt: Date;
};

export function aggregateSubmissions(
  submissions: { titleSlug: string; title: string; submittedAt: Date }[]
): AggregatedSolve[] {
  const byExternalId = new Map<string, AggregatedSolve>();

  for (const submission of submissions) {
    const externalId = toExternalId(submission.titleSlug);
    const existing = byExternalId.get(externalId);

    if (!existing) {
      byExternalId.set(externalId, {
        externalId,
        titleSlug: submission.titleSlug,
        title: submission.title,
        solvedAt: submission.submittedAt,
      });
      continue;
    }

    // Earliest accepted submission wins.
    if (submission.submittedAt < existing.solvedAt) {
      existing.solvedAt = submission.submittedAt;
    }
  }

  // Sorted by externalId so batches are built in a deterministic order — two
  // identical runs then issue byte-identical writes, which is what makes a diff
  // between two runs meaningful. Same reasoning as the unique tie-breaker on
  // every sort in the recommendation engine.
  return [...byExternalId.values()].sort((a, b) =>
    a.externalId.localeCompare(b.externalId)
  );
}
