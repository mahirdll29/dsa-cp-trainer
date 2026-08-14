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
import { UnmappedTagCounter, mapTagsToSlugs } from "./tags";

// ---------------------------------------------------------------------------
// THE WRITE PATHS.
//
// TWO SEPARATE CONCERNS, and keeping them separate is the most important
// structural decision in this module:
//
//   CATALOG SYNC  global, user-less, run as an npm script. Writes Problem and
//                 ProblemTopic only. This is the CANDIDATE POOL.
//   USER SYNC     per-user, behind requireAuth. Writes UserProblem and
//                 RatingChange, plus any Problem the catalog missed.
//
// WHY THE CATALOG CANNOT JUST BE A BY-PRODUCT OF USER IMPORTS. The engine's
// candidate query (engine/recommend.ts) filters with:
//
//     userProblems: { none: { userId, status: SolveStatus.SOLVED } }
//
// It only ever returns problems the user has NOT solved. If Problem were
// populated purely from a user's own submissions, every row in the table would
// be one they had already touched — so the weak-topic stage and the exploratory
// stage would return nothing, for every user, permanently. The engine verified
// in Module 3 would go dead against real data, and it would fail SILENTLY,
// because an empty candidate list is indistinguishable from "nothing suitable
// found today".
//
// So the pool has to be reference data that exists independently of anybody's
// history. That is exactly what problemset.problems provides.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// WHY EVERY WRITE BELOW IS SET-BASED, AND WHY THAT IS NOT PREMATURE OPTIMIZATION
//
// Measured round-trip time to this project's Neon instance: ~250-450 ms. That
// is not a typical local-Postgres number and it changes what "simple" means
// here. Written the obvious way — one prisma.upsert per problem in a loop —
// this module would take:
//
//     catalog (11,051 problems + 25,663 links)  ~194 minutes
//     one heavy user sync (2,831 problems)       ~31 minutes
//
// ROUND TRIPS ARE THE ENTIRE BUDGET, and they do not parallelize away: ten
// concurrent trivial queries through the Neon pooler took 2.4 s, essentially
// the serial cost. So the shape has to be read-once, diff-in-memory,
// write-in-batches. That turns thousands of round trips into roughly twenty.
//
// IDEMPOTENCY IS PRESERVED, and it is still the recovery mechanism. There is NO
// wrapping transaction — thousands of writes in one Prisma transaction against
// Neon would simply time out. Instead every write is keyed on a natural unique
// (Problem.provider+externalId, ProblemTopic's compound PK, UserProblem's
// userId+problemId, RatingChange's new linkedAccountId+contestId), so a run
// that dies halfway and is retried converges on the same state rather than
// duplicating anything.
//
// THAT PROPERTY IS THE ANSWER TO "what happens if it fails halfway": you run it
// again. syncStatus is how you know you need to.
//
// It also makes the idempotent case CHEAP rather than merely correct: a second
// run finds nothing new and nothing changed, so it costs a handful of round
// trips instead of thousands.
// ---------------------------------------------------------------------------

// Postgres caps a statement at 65,535 bind parameters. UserProblem's createMany
// binds 6 columns per row, so the hard ceiling is ~10,900 rows; 1,000 keeps us
// far away from it and keeps individual payloads modest.
const BATCH_SIZE = 1_000;

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

// ---------------------------------------------------------------------------
// SHARED HELPER — the reason this file exists as a file.
//
// CLAUDE.md's bar for extracting logic is "two genuine callers". This clears
// it: the catalog script imports the whole problemset, and the user sync must
// import any problem it encounters that the catalog missed (a gym problem, or
// one added upstream since the last catalog run). Both need identical
// Problem + ProblemTopic write behaviour, and if they diverged the two paths
// could write the same problem two different ways.
// ---------------------------------------------------------------------------

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
  // --- 1. Topic slugs -> ids. One query, 32 rows. ---------------------------
  //
  // Hard prerequisite: the topic seed must have run. Without it every slug
  // resolves to nothing, every problem imports with zero topics, and the engine
  // silently has no candidates — a failure that looks like "the importer
  // worked" until recommendations come back empty. So it fails loudly instead.
  const topics = await prisma.topic.findMany({ select: { id: true, slug: true } });
  if (topics.length === 0) {
    throw new Error(
      "No topics in the database. Run `npm run prisma:seed` before syncing Codeforces data."
    );
  }
  const topicIdBySlug = new Map(topics.map((t) => [t.slug, t.id]));

  // --- 2. Read the problems we are about to write. --------------------------
  //
  // READ ONLY WHAT YOU ARE ABOUT TO WRITE, in batches.
  //
  // An earlier version read the whole Codeforces catalog unconditionally. A
  // user sync touching 543 problems was therefore pulling all 11,056 problem
  // rows and all 25,663 topic links, and a re-sync that wrote NOTHING still
  // took 18.9 s.
  //
  // THE MEASURED TRADE, both numbers real, because this is NOT free:
  //
  //     user sync (543 problems)   18.9 s -> 13-16 s
  //     catalog re-run (11k)        6.7 s -> 23.6 s
  //
  // The catalog got THREE TIMES SLOWER, because it wants every row anyway and
  // now fetches them as 12 batched round trips instead of 1. Taken alone that
  // is a bad trade. It is the right one here only because of WHO IS WAITING:
  // the catalog is an npm script run occasionally with no user attached, while
  // the user sync is a synchronous HTTP request somebody is watching a spinner
  // for. Seconds are worth more on one side than the other.
  //
  // A size threshold would win both, and was rejected: two code paths through
  // the most correctness-critical function in the module, to save a script
  // 17 seconds nobody experiences.
  //
  // The batching is what makes the scoped version safe at all: an
  // 11,000-element IN would be one enormous statement, whereas 1,000 at a time
  // stays far inside Postgres' 65,535 bind-parameter ceiling.
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

  // --- 3. Diff in memory. ---------------------------------------------------
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

    // Only update rows that ACTUALLY differ. This is what makes a re-run
    // nearly free: Codeforces re-rates a handful of problems between runs, not
    // eleven thousand, so this list is normally empty and the expensive
    // per-row update loop never executes.
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
  // is the real guarantee; this keeps it from becoming a 500.
  for (const batch of chunk(toCreate, BATCH_SIZE)) {
    await prisma.problem.createMany({ data: batch, skipDuplicates: true });
  }

  // Per-row, because each row gets different values. Normally zero rows.
  for (const { id, data } of toUpdate) {
    await prisma.problem.update({ where: { id }, data });
  }

  // --- 5. Re-read ids, but only if we created anything. ---------------------
  //
  // createMany does not return the generated ids, and ProblemTopic needs them.
  // Skipping this query when nothing was created is what makes the idempotent
  // second run cheap.
  const problemIdByExternalId = new Map(
    existingProblems.map((p) => [p.externalId, p.id])
  );

  if (toCreate.length > 0) {
    // Only the ids we are missing — the rows that already existed were read in
    // step 2 and their ids have not changed.
    const createdExternalIds = toCreate.map((p) => p.externalId);
    for (const batch of chunk(createdExternalIds, BATCH_SIZE)) {
      const rows = await prisma.problem.findMany({
        where: { provider: Provider.CODEFORCES, externalId: { in: batch } },
        select: { id: true, externalId: true },
      });
      for (const row of rows) problemIdByExternalId.set(row.externalId, row.id);
    }
  }

  // --- 6. Topic links: diff, then batch. ------------------------------------
  //
  // Only the problems THIS RUN touched are considered. A stale-link cleanup
  // that ranged over the whole table could delete links belonging to problems
  // the run never saw, which is how a narrow bug becomes a wide one.
  const relevantProblemIds = new Set<string>();
  const desiredLinks = new Set<string>(); // "problemId|topicId"

  for (const [externalId, slugs] of desiredSlugs) {
    const problemId = problemIdByExternalId.get(externalId);
    if (!problemId) continue; // created concurrently and not visible; next run picks it up

    relevantProblemIds.add(problemId);
    for (const slug of slugs) {
      const topicId = topicIdBySlug.get(slug);
      // A slug in the mapping table with no matching Topic row means the map
      // and the seed have drifted apart. Skipped rather than crashing the
      // whole import over one bad row.
      if (!topicId) continue;
      desiredLinks.add(`${problemId}|${topicId}`);
    }
  }

  // Scoped to the problems this run touched, and batched, for the same reason
  // as the problem read above: a user sync has no business pulling all 25,663
  // topic links to reconcile 543 problems.
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
// Shipped as an npm script rather than an HTTP endpoint (same category as
// prisma:seed) because it is shared reference data: it is identical for every
// user, it does not belong to anybody, and putting it behind requireAuth would
// imply otherwise. It also takes long enough that no user should be waiting on
// it.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// USER SYNC — per-user, called by POST /api/integrations/codeforces/sync.
// ---------------------------------------------------------------------------

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

// A defensive MEMORY bound, not a time bound — and the distinction matters.
// Under batched writes the cost scales with DISTINCT PROBLEMS, not with
// submissions, so capping submissions buys little time. This exists purely so a
// pathological or hostile response cannot make us parse an unbounded payload.
// The heaviest well-known account (tourist) is 5,467.
const MAX_SUBMISSIONS = 20_000;

export async function syncCodeforcesUser(
  userId: string,
  linkedAccountId: string,
  handle: string
): Promise<UserSyncResult> {
  const startedAt = Date.now();

  // Two API calls, serialized and spaced by the client's rate gate.
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
  // submission (architecture.md 2.2).
  const aggregated = aggregateSubmissions(submissions);

  // Import any problem the catalog missed — gym problems especially, which
  // problemset.problems structurally never returns.
  const unmapped = new UnmappedTagCounter();
  const { counts: problemCounts, problemIdByExternalId } =
    await writeProblemsAndTopics(
      aggregated.solves.map((s) => s.problem),
      unmapped
    );

  // --- UserProblem: read, diff, batch ---------------------------------------
  //
  // Scoped to CODEFORCES problems so a future LeetCode sync cannot see or
  // disturb these rows.
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
    if (solve.status === SolveStatus.SOLVED) solved++;
    else attempted++;

    const problemId = problemIdByExternalId.get(solve.externalId);
    if (!problemId) continue; // problem row missing; the next sync picks it up

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

    // Again: only rows that genuinely changed. On a re-sync with no new
    // activity this list is empty, which is what keeps re-running cheap.
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

  // --- RatingChange: read, diff, batch --------------------------------------
  //
  // This is what the new @@unique([linkedAccountId, contestId]) protects.
  // Before it there was no uniqueness guard at all, so a second sync inserted
  // the entire rating history again and the progress graph drew every contest
  // twice.
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

  // --- HAND OFF TO THE ENGINE ----------------------------------------------
  //
  // THE CONSISTENCY OBLIGATION from architecture.md 2.2. TopicMastery is stored
  // rather than computed, and any stored copy of a derived fact rots unless
  // something refreshes it. If this call were skipped, the import would look
  // like it worked while every recommendation kept using pre-import mastery
  // scores — a silent wrong answer, which is the worst kind.
  //
  // engine/mastery.ts names the importers as the caller it was written for.
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

// ---------------------------------------------------------------------------
// UNLINK — what happens to data the link did not own.
//
// RatingChange hangs off LinkedAccount and cascades. But UserProblem,
// TopicMastery and RevisionItem hang off USER, so deleting the link leaves
// every imported solve behind, attributed to a handle the user no longer
// claims. Link handle A, sync, unlink, link handle B, sync — and one mastery
// profile is now built from two different people's histories, permanently and
// invisibly.
//
// THE DECISION: purge the Codeforces UserProblem rows and recompute.
//
// architecture.md 2.2 already settled it: "It is also re-importable: if we ever
// need it, the provider still has it. We are not the system of record for
// submissions." So this deletion is RECOVERABLE — re-link, re-sync, and every
// row comes back. The alternative (leave the data) is a silent correctness
// failure with NO recovery, because once two handles' rows are merged nothing
// records which came from which. A loud, recoverable loss beats a silent,
// permanent corruption.
//
// THE REFINEMENT: RevisionItem rows are deliberately LEFT ALONE. They are the
// one thing here Codeforces cannot give back — repetitionCount, dueAt and
// lastReviewedAt are progress the user earned inside our system. It is also
// defensible on its own terms: the revision ladder is a fact about the user's
// memory, not about which handle is linked. And it composes with
// scheduleRevisionForSolve's deliberately-empty upsert update, so unlink ->
// re-link -> re-sync restores the history AND resumes the ladder where it was.
//
// STATED COST: an accidental unlink discards imported solve history, and the
// user may keep seeing revision items for problems no longer in their solve
// record.
// ---------------------------------------------------------------------------

export type UnlinkResult = {
  userProblemsDeleted: number;
  topicsUpdated: number;
};

export async function unlinkCodeforcesAccount(
  userId: string,
  linkedAccountId: string
): Promise<UnlinkResult> {
  // Provider-scoped: LeetCode rows (Module 5) are untouched.
  const { count } = await prisma.userProblem.deleteMany({
    where: { userId, problem: { provider: Provider.CODEFORCES } },
  });

  // RatingChange cascades with the account.
  await prisma.linkedAccount.delete({ where: { id: linkedAccountId } });

  // Mastery is derived from the rows we just deleted, so it MUST be rebuilt.
  // recomputeMastery is a full rebuild, not a merge — it also drops mastery
  // rows for topics that no longer have any data, which is exactly what should
  // happen to a topic whose only evidence came from the unlinked account.
  const topicsUpdated = await recomputeMastery(userId);

  return { userProblemsDeleted: count, topicsUpdated };
}
