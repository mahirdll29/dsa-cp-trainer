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

// Two separate concerns, exactly as Module 4 - and for LeetCode the split is even
// more lopsided:
//   /problems               3,240 free problems, fully tagged and graded
//   /:username/acSubmission 20 rows, hard-capped, no tags, no difficulty
//
// So the CATALOG is the valuable half of this module: it is what fills the 11 topics
// Codeforces left empty and what the engine actually draws from. The user import is
// a thin bonus. A Problem table populated purely from a user's own history would
// recommend nothing, for everybody, forever - and silently.

// Postgres caps a statement at 65,535 bind parameters; 1,000 rows stays far inside it.
const BATCH_SIZE = 1_000;

// The wrapper hard-caps /problems at 100 per page whatever we ask for (measured:
// limit=500/1000/5000 all return exactly 100).
const PAGE_SIZE = 100;

// A runaway guard, not a real limit: 200 pages is five times the current catalog.
// Exists so a wrapper change that broke short-page termination cannot spin forever.
const MAX_PAGES = 200;

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

// Every write is set-based because round-trip latency to Neon is ~250-450 ms and does
// not parallelize. There is NO wrapping transaction; every write is keyed on a
// natural unique, so a run that dies halfway and is retried CONVERGES rather than
// duplicating. That is the answer to "what happens if it fails halfway": run it
// again, and syncStatus is how you know you need to.

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

// Two genuine callers: the catalog script writes whole pages, the user sync writes
// the handful of problems the catalog could not supply. If they diverged the two
// paths could write the same problem two different ways - which the unique cannot
// protect against, because it would see two different keys.
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

  // Hard prerequisite: the topic seed must have run. Without it every problem imports
  // with zero topics and the engine silently has no candidates - a failure that looks
  // like success until recommendations come back empty.
  const topics = await prisma.topic.findMany({
    select: { id: true, slug: true },
  });
  if (topics.length === 0) {
    throw new Error(
      "No topics in the database. Run `npm run prisma:seed` before syncing LeetCode data."
    );
  }
  const topicIdBySlug = new Map(topics.map((t) => [t.slug, t.id]));

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
      // LeetCode's own word VERBATIM ("Medium"), which is what makes the band re-derivable
      // later without a re-import.
      difficultyRaw: problem.difficulty,
      difficultyBand: difficultyToBand(problem.difficulty),
    };

    const existing = existingByExternalId.get(externalId);
    if (!existing) {
      toCreate.push({ provider: Provider.LEETCODE, externalId, ...desired });
      continue;
    }

    // Only rows that ACTUALLY differ, so a re-run is nearly free: LeetCode retitles a
    // handful of problems between runs, not three thousand.
    if (
      existing.title !== desired.title ||
      existing.url !== desired.url ||
      existing.difficultyRaw !== desired.difficultyRaw ||
      existing.difficultyBand !== desired.difficultyBand
    ) {
      toUpdate.push({ id: existing.id, data: desired });
    }
  }

  // skipDuplicates is the concurrency guard, not the primary mechanism: two syncs at
  // once could both decide to create the same problem.
  for (const batch of chunk(toCreate, BATCH_SIZE)) {
    await prisma.problem.createMany({ data: batch, skipDuplicates: true });
  }

  // Per-row, because each row gets different values. Normally zero rows.
  for (const { id, data } of toUpdate) {
    await prisma.problem.update({ where: { id }, data });
  }

  // createMany does not return generated ids and ProblemTopic needs them. Skipping this
  // when nothing was created is what keeps an idempotent second run cheap.
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

  // Only the problems THIS RUN touched. A cleanup ranging over the whole table would
  // delete links belonging to problems the run never saw.
  const relevantProblemIds = new Set<string>();
  const desiredLinks = new Set<string>(); // "problemId|topicId"

  for (const [externalId, slugs] of desiredSlugs) {
    const problemId = problemIdByExternalId.get(externalId);
    if (!problemId) continue; // created concurrently; the next run picks it up

    relevantProblemIds.add(problemId);
    for (const slug of slugs) {
      const topicId = topicIdBySlug.get(slug);
      // A slug with no matching Topic row means tags.ts and seed.ts have drifted apart.
      // Skipped rather than crashing the whole import over one bad row.
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

  // Stale links: a tag REMOVED upstream, scoped to problems this run touched.
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

// Global, tied to no user - an npm script for the same reason as Module 4's.
//
// Pagination, which Codeforces did not need: /problems is hard-capped at 100 rows, so
// the same job takes 41 round trips. Termination is on a SHORT page, never an empty
// one, because skip past the end CLAMPS rather than emptying (skip=4000 -> 19 rows;
// skip=4019 -> THE SAME 19 rows). Stopping on a short page never enters that region.
//
// Writes happen PER PAGE, not at the end. That costs a few extra round trips and buys
// resumability: an interrupted run has already persisted everything before the
// interruption, so --skip=N resumes instead of restarting.

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

    // Premium problems are dropped: recommending one a free user cannot open is worse
    // than not recommending at all - a dead end presented as a next step, and the user
    // cannot tell our bug from their subscription. Measured cost: 779 of 4,019 (19.4%),
    // which is why the count is reported rather than buried.
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

    // Terminate on the number of rows the API SERVED, not the number that survived
    // validation. `items` excludes malformed rows, so one bad row in a full page makes
    // items.length 99 and silently ends the crawl mid-catalog, reporting success.
    if (result.items.length + result.malformed < PAGE_SIZE) break;

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

// The API's own ceiling. Asking for more is pointless (limit=1000 returns 20), but
// written as our request rather than a magic 20 so the intent stays visible.
const SUBMISSION_LIMIT = 20;

// THE acSubmission GAP. That endpoint returns no difficulty and no tags, and both
// difficulty columns are NOT NULL, so a solved problem missing from our catalog
// cannot have its row created from submission data alone. We call /select for each
// missing problem, up to this cap, and skip the rest.
//
// The reason a pure skip-and-wait is not enough is not the obvious one. Misses are
// not mostly brand-new problems the next catalog run would fix - there is a second,
// SYSTEMATIC source: PREMIUM problems, which we deliberately exclude from the
// catalog, so a user who solved one hits the gap on every sync FOREVER.
//
// Which is why this path imports premium problems even though the catalog refuses
// them. That looks contradictory and is not: the catalog is the RECOMMENDATION POOL
// ("do not suggest what the user cannot open"), this is the user's OWN HISTORY -
// they demonstrably could open it. The engine can never recommend it back at them,
// because it excludes problems they have solved.
//
// 10 bounds the worst case, not the expected one: ten serial calls at 1.5 s spacing
// add ~21 s, still well inside the five-minute stale-lock window.
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
  // submission.
  const solves = aggregateSubmissions(submissionsResult.items);

  const externalIds = solves.map((s) => s.externalId);

  const problemIdByExternalId = new Map<string, string>();
  for (const batch of chunk(externalIds, BATCH_SIZE)) {
    const rows = await prisma.problem.findMany({
      where: { provider: Provider.LEETCODE, externalId: { in: batch } },
      select: { id: true, externalId: true },
    });
    for (const row of rows) problemIdByExternalId.set(row.externalId, row.id);
  }

  const missing = solves.filter((s) => !problemIdByExternalId.has(s.externalId));
  const unmapped = new UnmappedTagCounter();

  let gapLookups = 0;
  let gapPremiumImported = 0;
  let problemsCreated = 0;
  const recovered: LcCatalogProblem[] = [];

  for (const solve of missing.slice(0, MAX_GAP_LOOKUPS)) {
    gapLookups++;
    const detail = await getProblemDetail(solve.titleSlug);

    // null means the wrapper returned {} or a shape we could not read. We do NOT invent a
    // difficulty to get past the NOT NULL columns - the solve is dropped and counted.
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

  const skippedMissingFromCatalog = solves.filter(
    (s) => !problemIdByExternalId.has(s.externalId)
  ).length;

  // Scoped to LEETCODE problems so the Codeforces rows are neither seen nor disturbed.
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

  // Deliberately NOT solves.length: a solve whose problem could not be resolved is
  // reported under skippedMissingFromCatalog, and counting it here too would overstate
  // what was imported.
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
        // Always SOLVED: acSubmission is accepted-only, so there is no verdict to interpret.
        // attemptCount is 1 because the endpoint carries no failure information and a
        // fabricated count would feed straight into the engine's struggle ranking.
        status: SolveStatus.SOLVED,
        attemptCount: 1,
        solvedAt: solve.solvedAt,
        lastAttemptedAt: solve.solvedAt,
      });
      continue;
    }

    // attemptCount is deliberately NOT in this comparison: if a Codeforces import or a
    // future feature ever raised it, re-syncing LeetCode must not stomp it back down to
    // our uninformative 1.
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

  // THE CONSISTENCY OBLIGATION. TopicMastery is stored rather than computed, and a
  // stored derived value rots unless something refreshes it.
  //
  // recomputeMastery is a full rebuild over ALL of the user's UserProblem rows and does
  // not filter by provider, so a user with both accounts linked gets ONE MERGED mastery
  // profile. That is intended, not an accident - see architecture.md for the bias it
  // introduces.
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

// Identical semantics to unlinkCodeforcesAccount - two providers behaving differently
// on unlink would be a bug, not a feature.
//
// UserProblem, TopicMastery and RevisionItem all hang off USER, not off the link, so
// deleting the link alone would leave every imported solve behind, attributed to an
// account the user no longer claims. The purge is RECOVERABLE; the alternative is a
// silent corruption with no recovery.
//
// RevisionItem rows are deliberately LEFT ALONE: that progress was earned here and
// the provider cannot give it back.

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

  // Mastery is derived from the rows just deleted, so it MUST be rebuilt. The full
  // rebuild also drops rows for topics that no longer have data.
  const topicsUpdated = await recomputeMastery(userId);

  return { userProblemsDeleted: count, topicsUpdated };
}
