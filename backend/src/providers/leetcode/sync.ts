import { DifficultyBand, Provider, SolveStatus } from "@prisma/client";
import prisma from "../../lib/prisma";
import { UnmappedTagCounter } from "../../lib/unmappedTagCounter";
import { recomputeMastery } from "../../engine/mastery";
import { syncRevisionSchedule } from "../../engine/revision";
import {
  getAcceptedSubmissions,
  getProblemDetail,
  getProblemsPage,
  type LcCatalogProblem,
} from "./client";
import {
  aggregateSubmissions,
  difficultyToBand,
  toExternalId,
  toProblemUrl,
} from "./mapping";
import { mapTagsToSlugs } from "./tags";

// ---------------------------------------------------------------------------
// THE WRITE PATHS.
//
// TWO SEPARATE CONCERNS, exactly as Module 4:
//
//   CATALOG SYNC  global, user-less, run as an npm script. Writes Problem and
//                 ProblemTopic only. This is the CANDIDATE POOL.
//   USER SYNC     per-user, behind requireAuth. Writes UserProblem, plus any
//                 Problem the catalog could not supply.
//
// FOR LEETCODE THE SPLIT IS EVEN MORE LOPSIDED THAN FOR CODEFORCES, and it is
// worth being blunt about why:
//
//   /problems         3,240 free problems, fully tagged and graded
//   /:username/acSubmission   20 rows, hard-capped, no tags, no difficulty
//
// The test account has 502 solved problems and this API will surrender 20 of
// them. So the CATALOG is the valuable half of this module — it is what fills
// the 11 topics Codeforces left empty and what the recommendation engine
// actually draws from. The user import is a thin bonus.
//
// The engine's candidate query (engine/recommend.ts) filters with
// `userProblems: { none: { userId, status: SOLVED } }`, so it only ever returns
// problems the user has NOT solved. A Problem table populated purely from a
// user's own history would therefore recommend nothing, for everybody, forever
// — and it would fail SILENTLY, because an empty candidate list looks exactly
// like "nothing suitable today". That is why the catalog exists as reference
// data independent of anybody's history.
// ---------------------------------------------------------------------------

// Postgres caps a statement at 65,535 bind parameters. 1,000 rows keeps every
// createMany far inside that ceiling and keeps individual payloads modest.
// Same value as Module 4.
const BATCH_SIZE = 1_000;

// The wrapper hard-caps /problems at 100 per page regardless of what we ask
// for (measured: limit=500/1000/5000 all return exactly 100). Asking for the
// cap rather than guessing lower means the fewest possible round trips.
const PAGE_SIZE = 100;

// A RUNAWAY GUARD, not a real limit. The catalog is 41 pages today; 200 pages
// is 20,000 problems, five times the current size. This exists so a wrapper
// change that broke the short-page termination rule cannot spin forever
// against somebody's free instance.
const MAX_PAGES = 200;

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

// ---------------------------------------------------------------------------
// WHY EVERY WRITE BELOW IS SET-BASED
//
// Measured round-trip time to this project's Neon instance: ~250-450 ms, and
// it does not parallelize (ten concurrent trivial queries took 2.4 s — the
// serial cost, because the pooler serializes). Written the obvious way, one
// prisma.upsert per problem in a loop, the catalog import alone would be
// thousands of round trips.
//
// So the shape is read-once, diff-in-memory, write-in-batches. That is not
// premature optimization; at this latency it is the difference between a
// script that finishes and one that does not (session-handoff trap 8).
//
// NO WRAPPING TRANSACTION, and idempotency is the recovery mechanism. Every
// write is keyed on a natural unique (Problem.provider+externalId,
// ProblemTopic's compound PK, UserProblem's userId+problemId), so a run that
// dies halfway and is retried CONVERGES rather than duplicating. That property
// is the answer to "what happens if it fails halfway": you run it again, and
// syncStatus is how you know you need to.
// ---------------------------------------------------------------------------

export type ProblemWriteCounts = {
  problemsCreated: number;
  problemsUpdated: number;
  topicLinksCreated: number;
  topicLinksDeleted: number;
  problemsWithNoTopic: number;
};

const EMPTY_COUNTS: ProblemWriteCounts = {
  problemsCreated: 0,
  problemsUpdated: 0,
  topicLinksCreated: 0,
  topicLinksDeleted: 0,
  problemsWithNoTopic: 0,
};

// ---------------------------------------------------------------------------
// SHARED HELPER — two genuine callers, which is CLAUDE.md's bar for extraction.
//
// The catalog script writes whole pages of problems; the user sync writes the
// handful of problems the catalog could not supply (see the gap discussion in
// syncLeetcodeUser). Both need identical Problem + ProblemTopic behaviour, and
// if they diverged the two paths could write the same problem two different
// ways — which is exactly what @@unique([provider, externalId]) cannot protect
// against, because it would see two different keys.
// ---------------------------------------------------------------------------
async function writeProblemsAndTopics(
  problems: LcCatalogProblem[],
  unmapped: UnmappedTagCounter
): Promise<{
  counts: ProblemWriteCounts;
  problemIdByExternalId: Map<string, string>;
}> {
  if (problems.length === 0) {
    return { counts: { ...EMPTY_COUNTS }, problemIdByExternalId: new Map() };
  }

  // --- 1. Topic slugs -> ids. One query, 32 rows. ---------------------------
  //
  // HARD PREREQUISITE: the topic seed must have run. Without it every slug
  // resolves to nothing, every problem imports with zero topics, and the engine
  // silently has no candidates — a failure that looks like "the importer
  // worked" right up until recommendations come back empty. So it fails loudly.
  const topics = await prisma.topic.findMany({
    select: { id: true, slug: true },
  });
  if (topics.length === 0) {
    throw new Error(
      "No topics in the database. Run `npm run prisma:seed` before syncing LeetCode data."
    );
  }
  const topicIdBySlug = new Map(topics.map((t) => [t.slug, t.id]));

  // --- 2. Read only the problems we are about to write, in batches. ---------
  const wantedExternalIds = problems.map((p) => toExternalId(p.titleSlug));

  const existingProblems: {
    id: string;
    externalId: string;
    title: string;
    url: string;
    difficultyRaw: string;
    difficultyBand: DifficultyBand;
  }[] = [];

  for (const batch of chunk(wantedExternalIds, BATCH_SIZE)) {
    const rows = await prisma.problem.findMany({
      where: { provider: Provider.LEETCODE, externalId: { in: batch } },
      select: {
        id: true,
        externalId: true,
        title: true,
        url: true,
        difficultyRaw: true,
        difficultyBand: true,
      },
    });
    existingProblems.push(...rows);
  }

  const existingByExternalId = new Map(
    existingProblems.map((p) => [p.externalId, p])
  );

  // --- 3. Diff in memory. ---------------------------------------------------
  const toCreate: {
    provider: Provider;
    externalId: string;
    title: string;
    url: string;
    difficultyRaw: string;
    difficultyBand: DifficultyBand;
  }[] = [];
  const toUpdate: { id: string; data: Record<string, unknown> }[] = [];

  const desiredSlugs = new Map<string, string[]>();
  let problemsWithNoTopic = 0;

  for (const problem of problems) {
    const externalId = toExternalId(problem.titleSlug);

    const slugs = mapTagsToSlugs(problem.tagSlugs, unmapped);
    if (slugs.length === 0) problemsWithNoTopic++;
    desiredSlugs.set(externalId, slugs);

    const desired = {
      title: problem.title,
      url: toProblemUrl(problem.titleSlug),
      // difficultyRaw stores LeetCode's own word VERBATIM ("Medium"), which is
      // what makes the band re-derivable later without a re-import.
      difficultyRaw: problem.difficulty,
      difficultyBand: difficultyToBand(problem.difficulty),
    };

    const existing = existingByExternalId.get(externalId);
    if (!existing) {
      toCreate.push({ provider: Provider.LEETCODE, externalId, ...desired });
      continue;
    }

    // Only update rows that ACTUALLY differ. This is what makes a re-run nearly
    // free: LeetCode retitles or re-grades a handful of problems between runs,
    // not three thousand, so this list is normally empty and the per-row update
    // loop never executes.
    if (
      existing.title !== desired.title ||
      existing.url !== desired.url ||
      existing.difficultyRaw !== desired.difficultyRaw ||
      existing.difficultyBand !== desired.difficultyBand
    ) {
      toUpdate.push({ id: existing.id, data: desired });
    }
  }

  // --- 4. Write new problems in batches. ------------------------------------
  //
  // skipDuplicates is the concurrency guard, not the primary mechanism: the
  // in-memory diff already excludes rows we know exist, but two syncs running
  // at once could both decide to create the same problem. The unique constraint
  // is the real guarantee; this stops it becoming a 500.
  for (const batch of chunk(toCreate, BATCH_SIZE)) {
    await prisma.problem.createMany({ data: batch, skipDuplicates: true });
  }

  // Per-row, because each row gets different values. Normally zero rows.
  for (const { id, data } of toUpdate) {
    await prisma.problem.update({ where: { id }, data });
  }

  // --- 5. Re-read ids, but only if we created anything. ---------------------
  //
  // createMany does not return generated ids and ProblemTopic needs them.
  // Skipping this query when nothing was created is what keeps the idempotent
  // second run cheap.
  const problemIdByExternalId = new Map(
    existingProblems.map((p) => [p.externalId, p.id])
  );

  if (toCreate.length > 0) {
    const createdExternalIds = toCreate.map((p) => p.externalId);
    for (const batch of chunk(createdExternalIds, BATCH_SIZE)) {
      const rows = await prisma.problem.findMany({
        where: { provider: Provider.LEETCODE, externalId: { in: batch } },
        select: { id: true, externalId: true },
      });
      for (const row of rows) problemIdByExternalId.set(row.externalId, row.id);
    }
  }

  // --- 6. Topic links: diff, then batch. ------------------------------------
  //
  // Only the problems THIS RUN touched are considered. A stale-link cleanup
  // ranging over the whole table could delete links belonging to problems the
  // run never saw, which is how a narrow bug becomes a wide one.
  const relevantProblemIds = new Set<string>();
  const desiredLinks = new Set<string>(); // "problemId|topicId"

  for (const [externalId, slugs] of desiredSlugs) {
    const problemId = problemIdByExternalId.get(externalId);
    if (!problemId) continue; // created concurrently; the next run picks it up

    relevantProblemIds.add(problemId);
    for (const slug of slugs) {
      const topicId = topicIdBySlug.get(slug);
      // A slug in the mapping table with no matching Topic row means tags.ts
      // and prisma/seed.ts have drifted apart. Skipped rather than crashing the
      // whole import over one bad row.
      if (!topicId) continue;
      desiredLinks.add(`${problemId}|${topicId}`);
    }
  }

  const existingLinkRows: { problemId: string; topicId: string }[] = [];
  for (const batch of chunk([...relevantProblemIds], BATCH_SIZE)) {
    const rows = await prisma.problemTopic.findMany({
      where: { problemId: { in: batch } },
      select: { problemId: true, topicId: true },
    });
    existingLinkRows.push(...rows);
  }

  const existingLinkKeys = new Set(
    existingLinkRows.map((l) => `${l.problemId}|${l.topicId}`)
  );

  const linksToCreate: { problemId: string; topicId: string }[] = [];
  for (const key of desiredLinks) {
    if (existingLinkKeys.has(key)) continue;
    const [problemId, topicId] = key.split("|");
    linksToCreate.push({ problemId, topicId });
  }

  // Stale links: a tag REMOVED upstream. Scoped to problems this run touched,
  // so a link on an untouched problem is never collateral damage.
  const linksToDelete = existingLinkRows.filter(
    (l) =>
      relevantProblemIds.has(l.problemId) &&
      !desiredLinks.has(`${l.problemId}|${l.topicId}`)
  );

  for (const batch of chunk(linksToCreate, BATCH_SIZE)) {
    await prisma.problemTopic.createMany({ data: batch, skipDuplicates: true });
  }

  for (const batch of chunk(linksToDelete, BATCH_SIZE)) {
    await prisma.problemTopic.deleteMany({
      where: {
        OR: batch.map((l) => ({ problemId: l.problemId, topicId: l.topicId })),
      },
    });
  }

  return {
    counts: {
      problemsCreated: toCreate.length,
      problemsUpdated: toUpdate.length,
      topicLinksCreated: linksToCreate.length,
      topicLinksDeleted: linksToDelete.length,
      problemsWithNoTopic,
    },
    problemIdByExternalId,
  };
}

// ---------------------------------------------------------------------------
// CATALOG SYNC — global, tied to no user, no LinkedAccount.
//
// An npm script rather than an HTTP endpoint, same category as prisma:seed:
// the data is identical for every user, owned by nobody, and unrelated to any
// LinkedAccount. Putting it behind requireAuth would imply otherwise, and it
// takes long enough that no user should be waiting on it.
//
// PAGINATION, WHICH CODEFORCES DID NOT NEED. Module 4 got the entire 11k
// problemset in ONE call. Here /problems is hard-capped at 100 rows per
// request, so the same job takes 41 round trips through a 1.5 s rate gate.
//
// TERMINATION IS ON A SHORT PAGE, NOT AN EMPTY ONE, and that is deliberate:
// verified against the live API, skip past the end CLAMPS rather than
// emptying (skip=4000 -> 19 rows; skip=4019 -> THE SAME 19 rows; skip=4100 ->
// []). Stopping at the first page shorter than PAGE_SIZE never enters that
// region at all.
//
// WRITES HAPPEN PER PAGE, NOT AT THE END. That costs a few extra round trips
// per page, and buys the thing the extra trips are for: an interrupted run has
// already persisted everything before the interruption, so `--skip=N` resumes
// instead of restarting. A crawl that has to begin again from zero every time
// something goes wrong is not really resumable.
// ---------------------------------------------------------------------------

export type CatalogSyncResult = ProblemWriteCounts & {
  fetched: number;
  skippedPremium: number;
  malformed: number;
  pages: number;
  totalReported: number;
  durationMs: number;
};

export async function syncLeetcodeCatalog(
  startSkip = 0,
  onPage?: (info: {
    page: number;
    skip: number;
    got: number;
    total: number;
  }) => void
): Promise<CatalogSyncResult> {
  const startedAt = Date.now();
  const unmapped = new UnmappedTagCounter();

  const totals: ProblemWriteCounts = { ...EMPTY_COUNTS };
  let fetched = 0;
  let skippedPremium = 0;
  let malformed = 0;
  let pages = 0;
  let totalReported = 0;
  let skip = startSkip;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await getProblemsPage(PAGE_SIZE, skip);

    pages++;
    fetched += result.items.length;
    malformed += result.malformed;
    totalReported = result.total;

    onPage?.({ page, skip, got: result.items.length, total: result.total });

    // PREMIUM PROBLEMS ARE DROPPED, and this is a deliberate decision in the
    // same voice as Module 1 dropping unrated Codeforces problems.
    //
    // Recommending a problem a free user cannot open is worse than not
    // recommending one at all: it is a dead end presented as a next step, and
    // the user cannot tell our bug from their subscription. The check is one
    // field.
    //
    // MEASURED COST: 779 of 4,019 problems (19.4%) are excluded. That is not
    // nothing, and it is why the count is reported rather than buried.
    const importable = result.items.filter((p) => !p.isPaidOnly);
    skippedPremium += result.items.length - importable.length;

    if (importable.length > 0) {
      const { counts } = await writeProblemsAndTopics(importable, unmapped);
      totals.problemsCreated += counts.problemsCreated;
      totals.problemsUpdated += counts.problemsUpdated;
      totals.topicLinksCreated += counts.topicLinksCreated;
      totals.topicLinksDeleted += counts.topicLinksDeleted;
      totals.problemsWithNoTopic += counts.problemsWithNoTopic;
    }

    // The short-page termination rule. Also covers a completely empty page,
    // which is what a skip beyond the clamped region returns.
    if (result.items.length < PAGE_SIZE) break;

    skip += PAGE_SIZE;
  }

  unmapped.log("leetcode catalog");

  return {
    ...totals,
    fetched,
    skippedPremium,
    malformed,
    pages,
    totalReported,
    durationMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// USER SYNC — per-user, called by POST /api/integrations/leetcode/sync.
// ---------------------------------------------------------------------------

// The API's own ceiling. Asking for more is pointless — measured, limit=1000
// returns exactly 20 rows — but the constant is written as our request rather
// than as a magic 20 so the intent is visible: we want as much history as the
// endpoint will give us.
const SUBMISSION_LIMIT = 20;

// THE acSubmission GAP, AND THE CAP THAT BOUNDS IT.
//
// acSubmission returns titleSlug, title, timestamp, verdict and language. It
// does NOT return difficulty or topic tags. Problem.difficultyRaw and
// Problem.difficultyBand are both NOT NULL (a Module 1 decision that will not
// be undone here), so a solved problem missing from our catalog CANNOT have its
// row created from submission data alone.
//
// TWO OPTIONS WERE ON THE TABLE:
//   (a) call /select?titleSlug=X for each missing problem
//   (b) skip the solve, log it, let the next catalog sync pick it up
//
// (a) WAS CHOSEN, with (b) as the fallback beyond this cap. The measured gap is
// tiny — all 20 of the test account's recent solves were already in the free
// catalog — so this is normally ZERO extra calls.
//
// THE REASON (b) ALONE IS NOT ENOUGH, and it is not the reason you would
// expect. The obvious assumption is that misses are brand-new problems, which
// the next catalog run would fix. But there is a SECOND, SYSTEMATIC source:
// PREMIUM PROBLEMS. We deliberately exclude all 779 of them from the catalog,
// so a user who solved one hits the gap on every sync, FOREVER. The next
// catalog sync will never fix it, because skipping them is the design.
//
// WHICH IS WHY THE GAP PATH IMPORTS PREMIUM PROBLEMS EVEN THOUGH THE CATALOG
// REFUSES THEM. That looks contradictory and is not. The catalog is the
// RECOMMENDATION POOL — "do not suggest a problem the user cannot open". This
// is the user's OWN HISTORY — they have already solved it, so they
// demonstrably could open it. Importing it records the solve and credits the
// topic, and the engine can never recommend it back at them because
// engine/recommend.ts excludes problems they have solved. Different purposes,
// different rules.
//
// 10 is a deliberate bound on the WORST CASE, not an expected value: ten extra
// serial calls at 1.5 s spacing add ~21 s to a sync, which is still well inside
// the five-minute stale-lock window.
const MAX_GAP_LOOKUPS = 10;

export type UserSyncResult = {
  submissionsFetched: number;
  submissionsMalformed: number;
  distinctProblems: number;
  problemsCreated: number;
  gapLookups: number;
  gapPremiumImported: number;
  skippedMissingFromCatalog: number;
  userProblemsCreated: number;
  userProblemsUpdated: number;
  solved: number;
  topicsUpdated: number;
  revisionItemsCreated: number;
  unmappedTags: { tag: string; count: number }[];
  durationMs: number;
};

export async function syncLeetcodeUser(
  userId: string,
  handle: string
): Promise<UserSyncResult> {
  const startedAt = Date.now();

  const submissionsResult = await getAcceptedSubmissions(
    handle,
    SUBMISSION_LIMIT
  );

  // Aggregate BEFORE touching the database: one row per problem, never one per
  // submission (architecture.md 2.2).
  const solves = aggregateSubmissions(submissionsResult.items);

  // --- Which of these problems do we already have? --------------------------
  const externalIds = solves.map((s) => s.externalId);

  const problemIdByExternalId = new Map<string, string>();
  for (const batch of chunk(externalIds, BATCH_SIZE)) {
    const rows = await prisma.problem.findMany({
      where: { provider: Provider.LEETCODE, externalId: { in: batch } },
      select: { id: true, externalId: true },
    });
    for (const row of rows) problemIdByExternalId.set(row.externalId, row.id);
  }

  // --- Close the gap, up to the cap. ----------------------------------------
  const missing = solves.filter((s) => !problemIdByExternalId.has(s.externalId));
  const unmapped = new UnmappedTagCounter();

  let gapLookups = 0;
  let gapPremiumImported = 0;
  let problemsCreated = 0;
  const recovered: LcCatalogProblem[] = [];

  for (const solve of missing.slice(0, MAX_GAP_LOOKUPS)) {
    gapLookups++;
    const detail = await getProblemDetail(solve.titleSlug);

    // null means the wrapper returned `{}` (no such problem) or a shape we
    // could not read. Either way we do NOT invent a difficulty to get past the
    // NOT NULL columns — the solve is dropped and counted instead.
    if (!detail) continue;

    if (detail.isPaidOnly) gapPremiumImported++;
    recovered.push(detail);
  }

  if (recovered.length > 0) {
    const { counts, problemIdByExternalId: recoveredIds } =
      await writeProblemsAndTopics(recovered, unmapped);
    problemsCreated = counts.problemsCreated;
    for (const [externalId, id] of recoveredIds) {
      problemIdByExternalId.set(externalId, id);
    }
  }

  // Everything still unresolved is option (b): skipped, counted, reported.
  const skippedMissingFromCatalog = solves.filter(
    (s) => !problemIdByExternalId.has(s.externalId)
  ).length;

  // --- UserProblem: read, diff, batch ---------------------------------------
  //
  // Scoped to LEETCODE problems so the Codeforces rows are neither seen nor
  // disturbed — the exact mirror of Module 4's scoping.
  const existingUserProblems = await prisma.userProblem.findMany({
    where: { userId, problem: { provider: Provider.LEETCODE } },
    select: {
      id: true,
      problemId: true,
      status: true,
      attemptCount: true,
      solvedAt: true,
      lastAttemptedAt: true,
    },
  });
  const existingByProblemId = new Map(
    existingUserProblems.map((up) => [up.problemId, up])
  );

  const toCreate: {
    userId: string;
    problemId: string;
    status: SolveStatus;
    attemptCount: number;
    solvedAt: Date;
    lastAttemptedAt: Date;
  }[] = [];
  const toUpdate: { id: string; data: Record<string, unknown> }[] = [];

  // Solves that actually resolved to a Problem row and are therefore recorded.
  // Deliberately NOT the same as solves.length: a solve whose problem could not
  // be resolved is reported under skippedMissingFromCatalog, and counting it
  // here as well would overstate what was imported.
  let solved = 0;

  for (const solve of solves) {
    const problemId = problemIdByExternalId.get(solve.externalId);
    if (!problemId) continue; // counted above as skippedMissingFromCatalog
    solved++;

    const existing = existingByProblemId.get(problemId);
    if (!existing) {
      toCreate.push({
        userId,
        problemId,
        // ALWAYS SOLVED: acSubmission is accepted-only, so there is no verdict
        // to interpret. attemptCount is 1 because the endpoint carries no
        // failure information and a fabricated count would feed straight into
        // the engine's struggle ranking.
        status: SolveStatus.SOLVED,
        attemptCount: 1,
        solvedAt: solve.solvedAt,
        lastAttemptedAt: solve.solvedAt,
      });
      continue;
    }

    // A row that already exists is only touched if it genuinely differs, which
    // keeps a re-sync with no new activity free.
    //
    // NOTE attemptCount IS NOT IN THIS COMPARISON, and that is deliberate: if a
    // Codeforces-style import or a future feature ever raised it, re-syncing
    // LeetCode must not stomp it back down to our uninformative 1.
    const changed =
      existing.status !== SolveStatus.SOLVED ||
      existing.solvedAt?.getTime() !== solve.solvedAt.getTime();

    if (changed) {
      toUpdate.push({
        id: existing.id,
        data: {
          status: SolveStatus.SOLVED,
          solvedAt: solve.solvedAt,
          lastAttemptedAt: solve.solvedAt,
        },
      });
    }
  }

  for (const batch of chunk(toCreate, BATCH_SIZE)) {
    await prisma.userProblem.createMany({ data: batch, skipDuplicates: true });
  }
  for (const { id, data } of toUpdate) {
    await prisma.userProblem.update({ where: { id }, data });
  }

  // --- HAND OFF TO THE ENGINE ----------------------------------------------
  //
  // THE CONSISTENCY OBLIGATION from architecture.md 2.2. TopicMastery is stored
  // rather than computed, and any stored copy of a derived fact rots unless
  // something refreshes it. Skipping this would make the import look successful
  // while every recommendation kept using pre-import mastery — a silent wrong
  // answer, which is the worst kind.
  //
  // recomputeMastery is a FULL REBUILD over all of the user's UserProblem rows
  // and does not filter by provider. So a user with both accounts linked gets
  // ONE MERGED MASTERY PROFILE across Codeforces and LeetCode. That is intended
  // behaviour, not an accident of implementation — see architecture.md for the
  // bias it introduces.
  const topicsUpdated = await recomputeMastery(userId);
  const revisionItemsCreated = await syncRevisionSchedule(userId);

  return {
    submissionsFetched: submissionsResult.items.length,
    submissionsMalformed: submissionsResult.malformed,
    distinctProblems: solves.length,
    problemsCreated,
    gapLookups,
    gapPremiumImported,
    skippedMissingFromCatalog,
    userProblemsCreated: toCreate.length,
    userProblemsUpdated: toUpdate.length,
    solved,
    topicsUpdated,
    revisionItemsCreated,
    unmappedTags: unmapped.toSortedEntries(),
    durationMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// UNLINK — IDENTICAL SEMANTICS TO CODEFORCES (Module 4 decision 37).
//
// Two providers behaving differently on unlink would be a bug, not a feature,
// so this is the exact symmetric counterpart of unlinkCodeforcesAccount.
//
// UserProblem, TopicMastery and RevisionItem all hang off USER, not off the
// link. So deleting the link alone would leave every imported solve behind,
// attributed to an account the user no longer claims. Link account A, sync,
// unlink, link account B, sync — and one mastery profile is silently built from
// two different people's histories, permanently and invisibly.
//
// THE DECISION: purge the LeetCode UserProblem rows and recompute. That loss is
// RECOVERABLE — architecture.md 2.2 already establishes that we are not the
// system of record for submissions, so re-linking and re-syncing brings the
// rows back. The alternative is a silent correctness failure with NO recovery,
// because nothing records which handle a merged row came from. A loud
// recoverable loss beats a silent permanent corruption.
//
// THE REFINEMENT: RevisionItem rows are deliberately LEFT ALONE. They are the
// one thing the provider cannot give back — repetitionCount, dueAt and
// lastReviewedAt are progress the user earned inside our system, and the
// revision ladder is a fact about their memory, not about which account is
// linked.
//
// The delete is scoped by `problem: { provider: LEETCODE }`, exactly as the
// Codeforces version scopes to CODEFORCES, so neither provider's unlink can
// touch the other's rows.
//
// STATED COST: an accidental unlink discards imported solve history, and the
// user may keep seeing revision items for problems no longer in their record.
// ---------------------------------------------------------------------------

export type UnlinkResult = {
  userProblemsDeleted: number;
  topicsUpdated: number;
};

export async function unlinkLeetcodeAccount(
  userId: string,
  linkedAccountId: string
): Promise<UnlinkResult> {
  const { count } = await prisma.userProblem.deleteMany({
    where: { userId, problem: { provider: Provider.LEETCODE } },
  });

  await prisma.linkedAccount.delete({ where: { id: linkedAccountId } });

  // Mastery is derived from the rows just deleted, so it MUST be rebuilt.
  // recomputeMastery is a full rebuild rather than a merge — it also drops
  // mastery rows for topics that no longer have any data, which is exactly what
  // should happen to a topic whose only evidence came from the unlinked account.
  const topicsUpdated = await recomputeMastery(userId);

  return { userProblemsDeleted: count, topicsUpdated };
}
