import { DifficultyBand } from "@prisma/client";
import type { LcDifficulty } from "./client";

// titleSlug, not questionFrontendId: the slug is stable and IS the URL, whereas the
// frontend id renumbers. A pass-through today, but both import paths call it, so if
// the id scheme ever needs normalising there is one place to do it.
export function toExternalId(titleSlug: string): string {
  return titleSlug;
}

// Built, never taken from the API: /select returns a `link` field and /problems
// returns none, so using theirs where it exists would give the two import paths
// different URLs for the same problem - and `url` is a column we diff on, so every
// sync would flap those rows forever.
export function toProblemUrl(titleSlug: string): string {
  return `https://leetcode.com/problems/${titleSlug}/`;
}

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

// Far simpler than the Codeforces version, and the API is the reason. acSubmission
// returns ACCEPTED submissions only, so there is no verdict to interpret, and it
// carries no failure information, so attemptCount is 1 rather than a fabricated
// number that would feed the engine's struggle ranking. The one thing still worth
// doing is de-duplicating by slug: the 20-row window can hold two accepted
// submissions for one problem, and UserProblem is one row per (user, problem).

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

  // Sorted so two identical runs issue byte-identical writes.
  return [...byExternalId.values()].sort((a, b) =>
    a.externalId.localeCompare(b.externalId)
  );
}
