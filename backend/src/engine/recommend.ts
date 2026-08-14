import { DifficultyBand, Provider, SolveStatus } from "@prisma/client";
import prisma from "../lib/prisma";
import {
  EXPLORATORY_BAND,
  getMasteryOverview,
  TopicMasteryView,
  UnknownTopicView,
} from "./mastery";
import { getDueRevisions } from "./revision";

// ---------------------------------------------------------------------------
// RECOMMENDATION ASSEMBLY — the last stage of the pipeline:
//
//   UserProblem + ProblemTopic -> TopicMastery -> weak areas -> difficulty
//   -> candidate problems + due revisions -> recommendations
//
// Still no AI. Every line below is a rule someone chose and can defend, which
// is the entire point: the output is auditable. Module 6's AI layer will turn
// a `reason` string into a paragraph of encouragement; it will never change
// which problems appear or in what order.
// ---------------------------------------------------------------------------

// THE CAPS, and how they relate to each other.
//
// A session's worth of work, not a backlog. Twelve is a list a person will read
// to the end; thirty is a list they close.
const MAX_RECOMMENDATIONS = 12;

// No single topic may monopolise the list. Without this the weakest topic wins
// every slot, and a user handed twelve Dynamic Programming problems does not
// become good at DP — they close the tab.
const MAX_PER_TOPIC = 2;

const MAX_REVISIONS = 3;
const MAX_UNFINISHED = 2;
const WEAK_TOPICS_USED = 3;
const MAX_EXPLORATORY = 2;

// The per-stage caps deliberately sum to slightly more than the total
// (3 + 2 + 3*2 + 2 = 13 against 12). Stages run in priority order and each one
// takes only what is left, so an underfilled stage hands its slack to the ones
// after it — up to their own caps. When every later stage is also exhausted the
// list is simply shorter, which is the honest outcome: there is no rule here
// that pads a list to a round number.
//
// The overshoot matters for the last stage in particular. If the caps summed to
// exactly 12, a user with a full revision queue would never see an exploratory
// problem at all, and unknown topics would stay unknown forever.

export type Recommendation = {
  problemId: string;
  title: string;
  url: string;
  provider: Provider;
  difficultyRaw: string;
  difficultyBand: DifficultyBand;
  topics: string[];
  // A short machine-generated string: "weak in Dynamic Programming", "due for
  // revision". This is what makes the engine explainable, and it is the input
  // the AI layer will later render into human language.
  reason: string;
};

// The shape every stage produces, so one mapper serves all of them.
type ProblemWithTopics = {
  id: string;
  title: string;
  url: string;
  provider: Provider;
  difficultyRaw: string;
  difficultyBand: DifficultyBand;
  problemTopics: { topic: { name: string } }[];
};

function toRecommendation(
  problem: ProblemWithTopics,
  reason: string
): Recommendation {
  return {
    problemId: problem.id,
    title: problem.title,
    url: problem.url,
    provider: problem.provider,
    difficultyRaw: problem.difficultyRaw,
    difficultyBand: problem.difficultyBand,
    // Sorted so the same problem always renders its topics in the same order.
    // Determinism is not only about which problems appear — a field that
    // reshuffles between requests is just as confusing to a reader.
    topics: problem.problemTopics.map((link) => link.topic.name).sort(),
    reason,
  };
}

// Used when a reason needs to name a topic and the problem carries several.
// Alphabetically first, so the label never changes between requests.
function primaryTopicName(problem: ProblemWithTopics): string | null {
  const names = problem.problemTopics.map((link) => link.topic.name).sort();
  return names[0] ?? null;
}

// Candidate problems for one topic at one difficulty band.
//
// THE EXCLUSION THAT IS OBVIOUS AND THEREFORE EASY TO FORGET: never recommend
// something the user has already solved. It is enforced HERE, in the WHERE
// clause, rather than by filtering the results afterwards — a database that
// never returns the row cannot be undone by a later refactor that drops a
// filter.
//
// Note it excludes SOLVED only. A problem the user ATTEMPTED and abandoned is
// still eligible: it is a known gap they already have context on.
//
// `take` fetches a few more than needed because some candidates will already
// have been picked by an earlier stage (a problem can be tagged with two weak
// topics). Over-fetching a handful of rows is cheaper than a second round trip.
async function candidateProblemsForTopic(
  userId: string,
  topicId: string,
  difficultyBand: DifficultyBand,
  limit: number
): Promise<ProblemWithTopics[]> {
  return prisma.problem.findMany({
    where: {
      difficultyBand,
      problemTopics: { some: { topicId } },
      userProblems: { none: { userId, status: SolveStatus.SOLVED } },
    },
    select: {
      id: true,
      title: true,
      url: true,
      provider: true,
      difficultyRaw: true,
      difficultyBand: true,
      // ONE batched follow-up query for all of these problems' topics, not one
      // query per problem. This is the N+1 that would otherwise creep in while
      // building the `topics` array and the reason string.
      problemTopics: { select: { topic: { select: { name: true } } } },
    },
    // The deterministic tie-breaker. Without an ORDER BY on a unique column,
    // PostgreSQL is free to return equally-ranked rows in whatever order the
    // plan happens to produce, and that order can change between two identical
    // requests. `id` makes the total ordering unique and therefore stable.
    orderBy: { id: "asc" },
    take: limit,
  });
}

// ---------------------------------------------------------------------------
// COLD START — a brand-new user with zero UserProblem rows.
//
// Stages 1-3 all produce nothing for them: no solves means no revisions, no
// unfinished attempts, and no mastery rows to be weak in. Returning an empty
// list would be technically correct and completely useless — the one user who
// most needs direction gets none, and the system can never bootstrap, because
// it needs solve data to produce recommendations and needs recommendations to
// produce solve data.
//
// So they get a BREADTH sampler: one EASY problem from each of as many
// different topics as we can fill, ordered by topic name. Easy because nothing
// is known about them and a hard first problem is how people quit; one per
// topic because the goal of these ten problems is not practice, it is SIGNAL —
// spreading across topics generates the first mastery data, and every later
// recommendation is better for it.
// ---------------------------------------------------------------------------
async function coldStartRecommendations(
  topics: UnknownTopicView[]
): Promise<Recommendation[]> {
  // One query for the pool rather than one per topic. `take` is a sanity bound
  // so this cannot turn into "load the entire problem set" once imports have
  // filled the table.
  const pool = await prisma.problem.findMany({
    where: { difficultyBand: EXPLORATORY_BAND },
    select: {
      id: true,
      title: true,
      url: true,
      provider: true,
      difficultyRaw: true,
      difficultyBand: true,
      problemTopics: {
        select: { topicId: true, topic: { select: { name: true } } },
      },
    },
    orderBy: { id: "asc" },
    take: 200,
  });

  const byTopicId = new Map<string, ProblemWithTopics[]>();
  for (const problem of pool) {
    for (const link of problem.problemTopics) {
      const bucket = byTopicId.get(link.topicId) ?? [];
      bucket.push(problem);
      byTopicId.set(link.topicId, bucket);
    }
  }

  const recommendations: Recommendation[] = [];
  const used = new Set<string>();

  // `topics` arrives ordered by name, and each bucket preserves the id order of
  // the query above, so this walk is fully deterministic.
  for (const topic of topics) {
    if (recommendations.length >= MAX_RECOMMENDATIONS) break;

    const candidate = (byTopicId.get(topic.topicId) ?? []).find(
      (problem) => !used.has(problem.id)
    );
    if (!candidate) continue;

    used.add(candidate.id);
    recommendations.push(
      toRecommendation(candidate, `starting point: ${topic.name}`)
    );
  }

  return recommendations;
}

// ---------------------------------------------------------------------------
// THE PIPELINE
// ---------------------------------------------------------------------------

export async function buildRecommendations(
  userId: string,
  now: Date = new Date()
): Promise<Recommendation[]> {
  const overview = await getMasteryOverview(userId);

  // Cold start is a genuinely different branch, not a degenerate case of the
  // normal path, so it is written as one. Counting UserProblem rows is the
  // honest test of "has this user done anything at all" — mastery rows are
  // derived and could be stale or not yet recomputed.
  const historyCount = await prisma.userProblem.count({ where: { userId } });
  if (historyCount === 0) {
    return coldStartRecommendations(overview.unknown);
  }

  const recommendations: Recommendation[] = [];
  const used = new Set<string>();

  const remaining = () => MAX_RECOMMENDATIONS - recommendations.length;
  const add = (problem: ProblemWithTopics, reason: string) => {
    if (used.has(problem.id)) return;
    used.add(problem.id);
    recommendations.push(toRecommendation(problem, reason));
  };

  // --- STAGE 1: due revisions -----------------------------------------------
  //
  // REVIEWING BEATS NEW MATERIAL, and that ordering is a deliberate claim:
  // something about to be forgotten is worth more than something never learned.
  // New material adds breadth the user may also forget; a review protects
  // effort already spent. Miss the window and the original solve is wasted —
  // which is the whole premise of the spacing effect this schedule implements.
  //
  // This is the one stage that recommends already-solved problems, because a
  // revision item IS a solved problem. That is not a violation of the
  // exclusion rule, it is the reason the rule is scoped to the other stages.
  const dueRevisions = await getDueRevisions(userId, now);
  for (const item of dueRevisions.slice(0, MAX_REVISIONS)) {
    if (remaining() <= 0) break;
    add(item.problem, "due for revision");
  }

  // --- STAGE 2: unfinished attempts -----------------------------------------
  //
  // WHY THESE RANK HIGH: an unfinished problem is a KNOWN gap the user already
  // has context on. They have read the statement, formed an approach and hit a
  // wall — the expensive part is already paid for. Finishing it is cheaper and
  // more instructive than starting something cold, and leaving it unfinished is
  // how a specific weakness quietly becomes permanent.
  //
  // Ordered by attemptCount descending: the more they have banged on it, the
  // more it is worth closing out.
  if (remaining() > 0) {
    const unfinished = await prisma.userProblem.findMany({
      where: { userId, status: SolveStatus.ATTEMPTED },
      select: {
        problem: {
          select: {
            id: true,
            title: true,
            url: true,
            provider: true,
            difficultyRaw: true,
            difficultyBand: true,
            problemTopics: { select: { topic: { select: { name: true } } } },
          },
        },
      },
      orderBy: [{ attemptCount: "desc" }, { problemId: "asc" }],
      take: MAX_UNFINISHED,
    });

    for (const row of unfinished) {
      if (remaining() <= 0) break;
      const topicName = primaryTopicName(row.problem);
      add(
        row.problem,
        topicName ? `unfinished attempt in ${topicName}` : "unfinished attempt"
      );
    }
  }

  // --- STAGE 3: weak topics at their target difficulty -----------------------
  //
  // The three weakest topics WITH DATA. Unknown topics are deliberately absent
  // here — see stage 4.
  //
  // MAX_PER_TOPIC is what stops the weakest topic monopolising the list. A user
  // handed ten Dynamic Programming problems in a row does not become good at
  // DP, they close the tab; a list they will actually work through has to look
  // survivable.
  const weakTopics = overview.weak.slice(0, WEAK_TOPICS_USED);
  for (const topic of weakTopics) {
    if (remaining() <= 0) break;

    const candidates = await candidateProblemsForTopic(
      userId,
      topic.topicId,
      topic.targetBand,
      MAX_PER_TOPIC + MAX_RECOMMENDATIONS
    );

    let takenFromThisTopic = 0;
    for (const problem of candidates) {
      if (takenFromThisTopic >= MAX_PER_TOPIC || remaining() <= 0) break;
      if (used.has(problem.id)) continue;

      add(problem, `weak in ${topic.name}`);
      takenFromThisTopic += 1;
    }
    // If a topic has no unsolved problems at its target band it simply
    // contributes nothing. No fallback to another band: the band IS the
    // recommendation, and quietly handing a struggling user a HARD problem
    // because no EASY one was left would be worse than one fewer suggestion.
  }

  // --- STAGE 4: exploratory problems from unknown topics ---------------------
  //
  // One or two only. An unknown topic is not a weakness — we have no evidence
  // either way — so it earns a probe, not a course of study. Its purpose is to
  // generate the first data point, after which it becomes a known topic and the
  // ordinary weak-topic machinery takes over.
  const exploratoryTopics = overview.unknown.slice(0, MAX_EXPLORATORY);
  for (const topic of exploratoryTopics) {
    if (remaining() <= 0) break;

    const candidates = await candidateProblemsForTopic(
      userId,
      topic.topicId,
      EXPLORATORY_BAND,
      1 + MAX_RECOMMENDATIONS
    );

    const candidate = candidates.find((problem) => !used.has(problem.id));
    if (candidate) add(candidate, `new topic: ${topic.name}`);
  }

  // The stages append in priority order and each one respects the cap, so the
  // list is already correctly ordered and correctly sized. The slice is a
  // final guard, not the mechanism.
  return recommendations.slice(0, MAX_RECOMMENDATIONS);
}

// ---------------------------------------------------------------------------
// WHY DETERMINISM IS A REQUIREMENT, NOT A PREFERENCE
//
// There is no Math.random and no shuffling anywhere above, and every ORDER BY
// ends in a unique column. Three reasons:
//
// 1. TESTABLE. A fixed database state has exactly one correct output, so it can
//    be asserted. A recommender that returns a different list each call can
//    only be eyeballed, and "looks about right" is not a test.
// 2. EXPLAINABLE. Every item carries a reason. A reason that changes between
//    two refreshes is not a reason, it is a coincidence.
// 3. TRUSTWORTHY. A user who refreshes the page should see the same plan. A
//    study plan that reshuffles on every load reads as noise, and they stop
//    believing any of it.
//
// The single time-dependent input is `now`, used only to decide which revisions
// are due. That is inherent — "due" is a statement about the clock — and it is
// passed in as a parameter rather than read inside the query so a test can pin
// it.
// ---------------------------------------------------------------------------
