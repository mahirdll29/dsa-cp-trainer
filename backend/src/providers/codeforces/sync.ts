import { Provider, SolveStatus } from "@prisma/client";
import prisma from "../../lib/prisma";
import { recomputeMastery } from "../../engine/mastery";
import { syncRevisionSchedule } from "../../engine/revision";
import {
  getProblemsetProblems,
  getUserRatingChanges,
  getUserSubmissions,
} from "./client";
import {
  aggregateSubmissions,
  classifyProblem,
  ratingToBand,
  toExternalId,
  toProblemUrl,
  type ImportableProblem,
} from "./mapping";
import { UnmappedTagCounter } from "../../lib/unmappedTagCounter";
import { mapTagsToSlugs } from "./tags";

// Two separate concerns, and keeping them separate is the most important structural
// decision in this module:
//   CATALOG SYNC  global, user-less, an npm script. Writes Problem + ProblemTopic.
//                 This is the CANDIDATE POOL.
//   USER SYNC     per-user, behind requireAuth. Writes UserProblem + RatingChange,
//                 plus any Problem the catalog missed.
//
// The catalog cannot be a by-product of user imports. recommend.ts filters with
// `userProblems: { none: { userId, status: SOLVED } }`, so if Problem held only the
// user's own submissions every row would be one they had already touched and the
// engine would return nothing, for every user, permanently - and SILENTLY, because
// an empty candidate list is indistinguishable from "nothing suitable today".

// Every write below is set-based because round-trip latency to Neon is ~250-450 ms
// and does not parallelize. One prisma.upsert per problem in a loop would take ~194
// minutes for the catalog and ~31 for a heavy user sync.
//
// There is NO wrapping transaction - thousands of writes in one Prisma transaction
// against Neon would time out. Instead every write is keyed on a natural unique, so a
// run that dies halfway and is retried CONVERGES rather than duplicating. That is
// the answer to "what happens if it fails halfway": you run it again, and syncStatus
// is how you know you need to.

// Postgres caps a statement at 65,535 bind parameters; 1,000 rows stays far inside it.
const BATCH_SIZE = 1_000;

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

// Two genuine callers: the catalog script imports the whole problemset, and the user
// sync must import any problem the catalog missed (a gym problem, or one added
// upstream since the last run). If they diverged the two paths could write the same
// problem two different ways - which is exactly what the unique cannot protect
// against, because it would see two different keys.

export type ProblemWriteCounts = {
  problemsCreated: number;
  problemsUpdated: number;
  topicLinksCreated: number;
  topicLinksDeleted: number;
  problemsWithNoTopic: number;
};

async function writeProblemsAndTopics(
  problems: ImportableProblem[],
  unmapped: UnmappedTagCounter
): Promise<{ counts: ProblemWriteCounts; problemIdByExternalId: Map<string, string> }> {
  // Hard prerequisite: the topic seed must have run. Without it every slug resolves to
  // nothing, every problem imports with zero topics, and the engine silently has no
  // candidates - a failure that looks like success until recommendations come back
  // empty. So it fails loudly instead.
  const topics = await prisma.topic.findMany({ select: { id: true, slug: true } });
  if (topics.length === 0) {
    throw new Error(
      "No topics in the database. Run `npm run prisma:seed` before syncing Codeforces data."
    );
  }
  const topicIdBySlug = new Map(topics.map((t) => [t.slug, t.id]));

  // Read only what we are about to write, in batches. An earlier version read the whole
  // catalog unconditionally, so a user sync touching 543 problems pulled all 11,056
  // rows and a re-sync that wrote NOTHING still took 18.9 s.
  //
  // The measured trade, because this is not free: user sync 18.9 s -> 13-16 s, but
  // catalog re-run 6.7 s -> 23.6 s. The catalog got three times SLOWER. It is the right
  // trade only because of who is waiting - the catalog is a script with nobody attached,
  // the user sync is a request somebody is watching a spinner for.
  const wantedExternalIds = problems.map((p) =>
    toExternalId(p.contestId, p.index)
  );

  const existingProblems: {
    id: string;
    externalId: string;
    title: string;
    url: string;
    difficultyRaw: string;
    difficultyBand: ReturnType<typeof ratingToBand>;
  }[] = [];

  for (const batch of chunk(wantedExternalIds, BATCH_SIZE)) {
    const rows = await prisma.problem.findMany({
      where: { provider: Provider.CODEFORCES, externalId: { in: batch } },
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
    difficultyBand: ReturnType<typeof ratingToBand>;
  }[] = [];
  const toUpdate: { id: string; data: Record<string, unknown> }[] = [];

  // externalId -> the topic slugs it should be linked to
  const desiredSlugs = new Map<string, string[]>();
  let problemsWithNoTopic = 0;

  for (const problem of problems) {
    const externalId = toExternalId(problem.contestId, problem.index);

    const slugs = mapTagsToSlugs(problem.tags, unmapped);
    if (slugs.length === 0) problemsWithNoTopic++;
    desiredSlugs.set(externalId, slugs);

    const desired = {
      title: problem.name,
      url: toProblemUrl(problem.contestId, problem.index),
      difficultyRaw: String(problem.rating),
      difficultyBand: ratingToBand(problem.rating),
    };

    const existing = existingByExternalId.get(externalId);
    if (!existing) {
      toCreate.push({
        provider: Provider.CODEFORCES,
        externalId,
        ...desired,
      });
      continue;
    }

    // Only rows that ACTUALLY differ. Codeforces re-rates a handful of problems between
    // runs, not eleven thousand, so this list is normally empty and the per-row update
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

  // skipDuplicates is the concurrency guard, not the primary mechanism: the in-memory
  // diff already excludes rows we know exist, but two syncs at once could both decide
  // to create the same problem.
  for (const batch of chunk(toCreate, BATCH_SIZE)) {
    await prisma.problem.createMany({ data: batch, skipDuplicates: true });
  }

  // Per-row, because each row gets different values. Normally zero rows.
  for (const { id, data } of toUpdate) {
    await prisma.problem.update({ where: { id }, data });
  }

  // createMany does not return generated ids and ProblemTopic needs them. Skipping this
  // query when nothing was created is what keeps an idempotent second run cheap.
  const problemIdByExternalId = new Map(
    existingProblems.map((p) => [p.externalId, p.id])
  );

  if (toCreate.length > 0) {
    // Only the ids we are missing - existing rows were read in step 2.
    const createdExternalIds = toCreate.map((p) => p.externalId);
    for (const batch of chunk(createdExternalIds, BATCH_SIZE)) {
      const rows = await prisma.problem.findMany({
        where: { provider: Provider.CODEFORCES, externalId: { in: batch } },
        select: { id: true, externalId: true },
      });
      for (const row of rows) problemIdByExternalId.set(row.externalId, row.id);
    }
  }

  // Only the problems THIS RUN touched. A stale-link cleanup ranging over the whole
  // table would delete links belonging to problems the run never saw, which is how a
  // narrow bug becomes a wide one.
  const relevantProblemIds = new Set<string>();
  const desiredLinks = new Set<string>(); // "problemId|topicId"

  for (const [externalId, slugs] of desiredSlugs) {
    const problemId = problemIdByExternalId.get(externalId);
    if (!problemId) continue; // created concurrently and not visible; next run picks it up

    relevantProblemIds.add(problemId);
    for (const slug of slugs) {
      const topicId = topicIdBySlug.get(slug);
      // A slug with no matching Topic row means the map and the seed have drifted apart.
      // Skipped rather than crashing the whole import over one bad row.
      if (!topicId) continue;
      desiredLinks.add(`${problemId}|${topicId}`);
    }
  }

  // Scoped and batched for the same reason as the problem read: a user sync has no
  // business pulling all 25,663 topic links to reconcile 543 problems.
  const existingLinkRows: { problemId: string; topicId: string }[] = [];
  for (const batch of chunk([...relevantProblemIds], BATCH_SIZE)) {
    const rows = await prisma.problemTopic.findMany({
      where: { problemId: { in: batch } },
      select: { problemId: true, topicId: true },
    });
    existingLinkRows.push(...rows);
  }

  const linksToCreate: { problemId: string; topicId: string }[] = [];
  const existingLinkKeys = new Set(
    existingLinkRows.map((l) => `${l.problemId}|${l.topicId}`)
  );

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

// Global, tied to no user. An npm script rather than an HTTP endpoint (same category
// as prisma:seed) because the data is identical for every user and belongs to nobody,
// and it takes long enough that no user should be waiting on it.

export type CatalogSyncResult = ProblemWriteCounts & {
  fetched: number;
  skippedUnrated: number;
  skippedNoContestId: number;
  malformed: number;
  durationMs: number;
};

export async function syncCodeforcesCatalog(): Promise<CatalogSyncResult> {
  const startedAt = Date.now();

  const { items, malformed } = await getProblemsetProblems();

  const importable: ImportableProblem[] = [];
  let skippedUnrated = 0;
  let skippedNoContestId = 0;

  for (const problem of items) {
    const classified = classifyProblem(problem);
    if (!classified.importable) {
      if (classified.reason === "unrated") skippedUnrated++;
      else skippedNoContestId++;
      continue;
    }
    importable.push(classified.problem);
  }

  const unmapped = new UnmappedTagCounter();
  const { counts } = await writeProblemsAndTopics(importable, unmapped);
  unmapped.log("catalog");

  return {
    ...counts,
    fetched: items.length,
    skippedUnrated,
    skippedNoContestId,
    malformed,
    durationMs: Date.now() - startedAt,
  };
}

export type UserSyncResult = {
  submissionsFetched: number;
  submissionsMalformed: number;
  skippedUnrated: number;
  skippedNoContestId: number;
  problemsCreated: number;
  problemsUpdated: number;
  userProblemsCreated: number;
  userProblemsUpdated: number;
  solved: number;
  attempted: number;
  ratingChangesCreated: number;
  ratingChangesUpdated: number;
  topicsUpdated: number;
  revisionItemsCreated: number;
  unmappedTags: { tag: string; count: number }[];
  durationMs: number;
};

// A defensive MEMORY bound, not a time bound: under batched writes the cost scales
// with distinct problems, not submissions, so capping submissions buys little time.
// This exists so a hostile response cannot make us parse an unbounded payload.
const MAX_SUBMISSIONS = 20_000;

export async function syncCodeforcesUser(
  userId: string,
  linkedAccountId: string,
  handle: string
): Promise<UserSyncResult> {
  const startedAt = Date.now();

  const submissionsResult = await getUserSubmissions(handle);
  const ratingResult = await getUserRatingChanges(handle);

  let submissions = submissionsResult.items;
  if (submissions.length > MAX_SUBMISSIONS) {
    // Newest-first, so slicing keeps recent history and drops the oldest.
    console.warn(
      `[codeforces] ${handle} returned ${submissions.length} submissions; ` +
        `capping at ${MAX_SUBMISSIONS} (oldest dropped)`
    );
    submissions = submissions.slice(0, MAX_SUBMISSIONS);
  }

  // Aggregate BEFORE touching the database: one row per problem, never one per
  // submission.
  const aggregated = aggregateSubmissions(submissions);

  // Import any problem the catalog missed - gym problems especially, which
  // problemset.problems structurally never returns.
  const unmapped = new UnmappedTagCounter();
  const { counts: problemCounts, problemIdByExternalId } =
    await writeProblemsAndTopics(
      aggregated.solves.map((s) => s.problem),
      unmapped
    );

  // Scoped to CODEFORCES problems so a LeetCode sync can neither see nor disturb these
  // rows.
  const existingUserProblems = await prisma.userProblem.findMany({
    where: { userId, problem: { provider: Provider.CODEFORCES } },
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

  const userProblemsToCreate: {
    userId: string;
    problemId: string;
    status: SolveStatus;
    attemptCount: number;
    solvedAt: Date | null;
    lastAttemptedAt: Date;
  }[] = [];
  const userProblemsToUpdate: { id: string; data: Record<string, unknown> }[] = [];

  let solved = 0;
  let attempted = 0;

  for (const solve of aggregated.solves) {
    const problemId = problemIdByExternalId.get(solve.externalId);
    if (!problemId) continue; // problem row missing; the next sync picks it up

    // Counted after the row is known to be writable, so the reported totals describe what
    // was imported rather than what was seen. The LeetCode sync already does this.
    if (solve.status === SolveStatus.SOLVED) solved++;
    else attempted++;

    const existing = existingByProblemId.get(problemId);
    if (!existing) {
      userProblemsToCreate.push({
        userId,
        problemId,
        status: solve.status,
        attemptCount: solve.attemptCount,
        solvedAt: solve.solvedAt,
        lastAttemptedAt: solve.lastAttemptedAt,
      });
      continue;
    }

    // Only rows that genuinely changed, which is what keeps a re-sync cheap.
    const changed =
      existing.status !== solve.status ||
      existing.attemptCount !== solve.attemptCount ||
      existing.solvedAt?.getTime() !== solve.solvedAt?.getTime() ||
      existing.lastAttemptedAt.getTime() !== solve.lastAttemptedAt.getTime();

    if (changed) {
      userProblemsToUpdate.push({
        id: existing.id,
        data: {
          status: solve.status,
          attemptCount: solve.attemptCount,
          solvedAt: solve.solvedAt,
          lastAttemptedAt: solve.lastAttemptedAt,
        },
      });
    }
  }

  for (const batch of chunk(userProblemsToCreate, BATCH_SIZE)) {
    await prisma.userProblem.createMany({ data: batch, skipDuplicates: true });
  }
  for (const { id, data } of userProblemsToUpdate) {
    await prisma.userProblem.update({ where: { id }, data });
  }

  // This is what @@unique([linkedAccountId, contestId]) protects. Before it there was
  // no uniqueness guard at all, so a second sync inserted the entire rating history
  // again and the progress graph drew every contest twice.
  const existingRatingChanges = await prisma.ratingChange.findMany({
    where: { linkedAccountId },
    select: {
      id: true,
      contestId: true,
      contestName: true,
      oldRating: true,
      newRating: true,
      rank: true,
      ratedAt: true,
    },
  });
  const existingByContestId = new Map(
    existingRatingChanges.map((rc) => [rc.contestId, rc])
  );

  const ratingChangesToCreate: {
    linkedAccountId: string;
    contestId: number;
    contestName: string;
    oldRating: number;
    newRating: number;
    rank: number;
    ratedAt: Date;
  }[] = [];
  const ratingChangesToUpdate: { id: string; data: Record<string, unknown> }[] = [];

  for (const change of ratingResult.items) {
    const desired = {
      contestName: change.contestName,
      oldRating: change.oldRating,
      newRating: change.newRating,
      rank: change.rank,
      ratedAt: new Date(change.ratingUpdateTimeSeconds * 1000),
    };

    const existing = existingByContestId.get(change.contestId);
    if (!existing) {
      ratingChangesToCreate.push({
        linkedAccountId,
        contestId: change.contestId,
        ...desired,
      });
      continue;
    }

    // Codeforces does occasionally recalculate a past contest's ratings.
    const changed =
      existing.contestName !== desired.contestName ||
      existing.oldRating !== desired.oldRating ||
      existing.newRating !== desired.newRating ||
      existing.rank !== desired.rank ||
      existing.ratedAt.getTime() !== desired.ratedAt.getTime();

    if (changed) ratingChangesToUpdate.push({ id: existing.id, data: desired });
  }

  for (const batch of chunk(ratingChangesToCreate, BATCH_SIZE)) {
    await prisma.ratingChange.createMany({ data: batch, skipDuplicates: true });
  }
  for (const { id, data } of ratingChangesToUpdate) {
    await prisma.ratingChange.update({ where: { id }, data });
  }

  // THE CONSISTENCY OBLIGATION. TopicMastery is stored rather than computed, and a
  // stored derived value rots unless something refreshes it. Skip this and the import
  // looks like it worked while every recommendation keeps using pre-import scores - a
  // silent wrong answer, which is the worst kind.
  const topicsUpdated = await recomputeMastery(userId);
  const revisionItemsCreated = await syncRevisionSchedule(userId);

  return {
    submissionsFetched: submissionsResult.items.length,
    submissionsMalformed: submissionsResult.malformed + ratingResult.malformed,
    skippedUnrated: aggregated.skippedUnrated,
    skippedNoContestId: aggregated.skippedNoContestId,
    problemsCreated: problemCounts.problemsCreated,
    problemsUpdated: problemCounts.problemsUpdated,
    userProblemsCreated: userProblemsToCreate.length,
    userProblemsUpdated: userProblemsToUpdate.length,
    solved,
    attempted,
    ratingChangesCreated: ratingChangesToCreate.length,
    ratingChangesUpdated: ratingChangesToUpdate.length,
    topicsUpdated,
    revisionItemsCreated,
    unmappedTags: unmapped.toSortedEntries(),
    durationMs: Date.now() - startedAt,
  };
}

// UserProblem, TopicMastery and RevisionItem all hang off USER, not off the link. So
// deleting the link alone would leave every imported solve behind, attributed to a
// handle the user no longer claims: link handle A, sync, unlink, link handle B, sync,
// and one mastery profile is silently built from two different people's histories.
//
// So the solve rows are purged. That loss is RECOVERABLE - we are not the system of
// record for submissions - whereas the alternative is a silent corruption with no
// recovery, because nothing records which handle a merged row came from.
//
// RevisionItem rows are deliberately LEFT ALONE: repetitionCount, dueAt and
// lastReviewedAt are progress earned inside our system that the provider cannot give
// back, and the ladder is a fact about the user's memory, not about which handle is
// linked.

export type UnlinkResult = {
  userProblemsDeleted: number;
  topicsUpdated: number;
};

export async function unlinkCodeforcesAccount(
  userId: string,
  linkedAccountId: string
): Promise<UnlinkResult> {
  // Provider-scoped: LeetCode rows are untouched.
  const { count } = await prisma.userProblem.deleteMany({
    where: { userId, problem: { provider: Provider.CODEFORCES } },
  });

  await prisma.linkedAccount.delete({ where: { id: linkedAccountId } });

  // Mastery is derived from the rows just deleted, so it MUST be rebuilt. The full
  // rebuild also drops rows for topics that no longer have data - exactly what should
  // happen to a topic whose only evidence came from the unlinked account.
  const topicsUpdated = await recomputeMastery(userId);

  return { userProblemsDeleted: count, topicsUpdated };
}
