import bcrypt from "bcrypt";
import { DifficultyBand, Provider, SolveStatus } from "@prisma/client";
import prisma from "../src/lib/prisma";
import { syncRevisionSchedule } from "../src/engine/revision";

// ---------------------------------------------------------------------------
// DEVELOPMENT SEED — NOT the production seed.
//
// prisma/seed.ts seeds the 32 canonical topics and is real production data.
// THIS file fabricates users, problems and solve history so the recommendation
// engine can be verified before the import modules exist.
//
// WHY THIS IS LEGITIMATE ENGINEERING AND NOT A SHORTCUT: the engine's
// correctness has nothing to do with where its input came from. Building this
// lets the algorithm be tested independently of the Codeforces and LeetCode
// importers — which is not just convenient, it is better testing, because a
// failing recommendation can only be the engine's fault. It also means the
// import modules can be built against an engine already known to work.
//
// It never creates or modifies a Topic. It looks the 32 seeded topics up by
// slug and fails loudly if one is missing.
//
// Everything here is idempotent: every write is an upsert on a natural key, so
// running it twice produces the same rows, not two sets of them.
//
// Remove it all again with:  npm run dev:seed:clean
// ---------------------------------------------------------------------------

const DEV_PASSWORD = "devpassword123";

// The same conversion the importers will do at import time (architecture.md
// 2.2). Codeforces cutoffs are Module 1's judgment call: <1200 EASY,
// 1200-1799 MEDIUM, >=1800 HARD.
function bandForRating(rating: number): DifficultyBand {
  if (rating < 1200) return DifficultyBand.EASY;
  if (rating < 1800) return DifficultyBand.MEDIUM;
  return DifficultyBand.HARD;
}

function bandForLeetCode(label: string): DifficultyBand {
  if (label === "Easy") return DifficultyBand.EASY;
  if (label === "Medium") return DifficultyBand.MEDIUM;
  return DifficultyBand.HARD;
}

type SeedProblem = {
  externalId: string;
  provider: Provider;
  title: string;
  difficultyRaw: string;
  difficultyBand: DifficultyBand;
  topicSlugs: string[];
};

function codeforces(
  externalId: string,
  title: string,
  rating: number,
  topicSlugs: string[]
): SeedProblem {
  return {
    externalId,
    provider: Provider.CODEFORCES,
    title,
    // difficultyRaw keeps the provider's own value verbatim; difficultyBand is
    // the normalized value the engine reads. Both stored, converted once, here.
    difficultyRaw: String(rating),
    difficultyBand: bandForRating(rating),
    topicSlugs,
  };
}

function leetcode(
  externalId: string,
  title: string,
  label: "Easy" | "Medium" | "Hard",
  topicSlugs: string[]
): SeedProblem {
  return {
    externalId,
    provider: Provider.LEETCODE,
    title,
    difficultyRaw: label,
    difficultyBand: bandForLeetCode(label),
    topicSlugs,
  };
}

// Both providers, all three bands, spread across 12 of the 32 topics — the
// other 20 are deliberately left with no problems at all so the UNKNOWN path
// is exercised by real data rather than assumed.
const PROBLEMS: SeedProblem[] = [
  // --- Codeforces --------------------------------------------------------
  codeforces("dev-cf-1", "Watermelon", 800, ["arrays"]),
  codeforces("dev-cf-2", "Way Too Long Words", 800, ["strings"]),
  codeforces("dev-cf-3", "Team", 800, ["arrays"]),
  codeforces("dev-cf-4", "Next Round", 800, ["arrays"]),
  codeforces("dev-cf-5", "Boy or Girl", 800, ["strings"]),
  codeforces("dev-cf-6", "Soft Drinking", 800, ["two-pointers"]),
  codeforces("dev-cf-7", "Vanya and Fence", 1000, ["greedy"]),
  codeforces("dev-cf-8", "Divisibility Problem", 1000, ["greedy"]),
  codeforces("dev-cf-9", "Two Buttons", 1400, ["graphs"]),
  codeforces("dev-cf-10", "Ilya and Queries", 1400, ["strings"]),
  codeforces("dev-cf-11", "Kefa and Park", 1500, ["trees"]),
  codeforces("dev-cf-12", "Mahmoud and Ehab and the Bipartiteness", 1600, [
    "dynamic-programming",
  ]),
  codeforces("dev-cf-13", "Vasya and Golden Ticket", 1500, [
    "dynamic-programming",
  ]),
  codeforces("dev-cf-14", "Dominoes", 1900, ["dynamic-programming"]),
  codeforces("dev-cf-15", "Sonya and Ice Cream", 2000, ["graphs"]),
  codeforces("dev-cf-16", "Sorted Queries", 1800, ["binary-search"]),
  codeforces("dev-cf-17", "Bear and Big Brother", 800, ["arrays"]),
  codeforces("dev-cf-18", "Petya and Strings", 800, ["arrays"]),
  codeforces("dev-cf-19", "Word Capitalization", 800, ["arrays"]),
  codeforces("dev-cf-20", "Free Ice Cream", 900, ["arrays"]),
  codeforces("dev-cf-21", "Fibonacci Warmup", 1100, ["dynamic-programming"]),
  codeforces("dev-cf-22", "Binary Search Hunt", 1500, ["binary-search"]),
  codeforces("dev-cf-23", "BST Insert", 900, ["binary-search-tree"]),
  codeforces("dev-cf-24", "Simple BFS", 1100, ["breadth-first-search"]),

  // --- LeetCode ----------------------------------------------------------
  leetcode("dev-lc-1", "Two Sum", "Easy", ["arrays"]),
  leetcode("dev-lc-2", "Binary Search", "Easy", ["binary-search"]),
  leetcode("dev-lc-3", "Valid Anagram", "Easy", ["strings"]),
  leetcode("dev-lc-4", "Move Zeroes", "Easy", ["arrays", "two-pointers"]),
  leetcode("dev-lc-5", "Climbing Stairs", "Easy", ["dynamic-programming"]),
  leetcode("dev-lc-6", "Search Insert Position", "Easy", ["binary-search"]),
  leetcode("dev-lc-7", "Coin Change", "Medium", ["dynamic-programming"]),
  leetcode("dev-lc-8", "House Robber", "Medium", ["dynamic-programming"]),
  leetcode("dev-lc-9", "Course Schedule", "Medium", ["graphs"]),
  leetcode(
    "dev-lc-10",
    "Longest Substring Without Repeating Characters",
    "Medium",
    ["strings", "two-pointers"]
  ),
  leetcode("dev-lc-11", "Find Peak Element", "Medium", ["binary-search"]),
  leetcode("dev-lc-12", "Word Ladder", "Hard", ["graphs"]),
  leetcode("dev-lc-13", "Edit Distance", "Hard", ["dynamic-programming"]),
  leetcode("dev-lc-14", "Median of Two Sorted Arrays", "Hard", [
    "binary-search",
  ]),
  leetcode("dev-lc-15", "Jump Game", "Medium", ["greedy"]),
  leetcode("dev-lc-16", "Binary Tree Level Order Traversal", "Medium", [
    "trees",
  ]),
  leetcode("dev-lc-17", "Best Time to Buy and Sell Stock", "Easy", ["arrays"]),
  leetcode("dev-lc-18", "Contains Duplicate", "Easy", ["arrays"]),
  leetcode("dev-lc-19", "Min Cost Climbing Stairs", "Easy", [
    "dynamic-programming",
  ]),
  leetcode("dev-lc-20", "Search in Rotated Sorted Array", "Medium", [
    "binary-search",
  ]),
  leetcode("dev-lc-21", "Number of Islands", "Medium", ["graphs"]),
  leetcode("dev-lc-22", "Subsets Warmup", "Easy", ["backtracking"]),
  leetcode("dev-lc-23", "Single Number", "Easy", ["bit-manipulation"]),
];

type SeedUser = {
  email: string;
  name: string;
  solved: string[];
  // [externalId, attemptCount] — attempted but never solved
  attempted: [string, number][];
};

// THE THREE PROFILES, each chosen to exercise a specific branch of the engine.
const USERS: SeedUser[] = [
  {
    // Strong Arrays, weak Dynamic Programming, and — the interesting one —
    // Greedy with a single solve and no failures. The naive formula scores
    // that 1.0 and calls Greedy her best topic; the smoothed formula scores it
    // 0.51 and correctly puts it among her weakest. That one row is the whole
    // argument for smoothing, in data.
    email: "dev-alice@example.com",
    name: "Dev Alice",
    solved: [
      // Arrays — 10 solved, 1 abandoned. Real volume, so a real score.
      "dev-cf-1",
      "dev-cf-3",
      "dev-cf-4",
      "dev-cf-17",
      "dev-cf-18",
      "dev-cf-19",
      "dev-cf-20",
      "dev-lc-1",
      "dev-lc-17",
      "dev-lc-4",
      // Strings — 4 solved, 0 failed. Lands exactly on the weak/strong border.
      "dev-cf-2",
      "dev-cf-5",
      "dev-lc-3",
      "dev-lc-10",
      // Binary Search — 3 of 4.
      "dev-lc-2",
      "dev-lc-6",
      "dev-lc-11",
      // One solve each in DP, Graphs and Greedy.
      "dev-lc-5",
      "dev-lc-9",
      "dev-cf-7",
    ],
    attempted: [
      ["dev-cf-12", 5], // most-attempted: first unfinished recommendation
      ["dev-lc-7", 4], // second
      ["dev-cf-13", 3],
      ["dev-cf-9", 3],
      ["dev-lc-8", 2],
      ["dev-cf-14", 2],
      ["dev-lc-12", 2],
      ["dev-lc-14", 2],
      ["dev-lc-18", 1],
    ],
  },
  {
    // A DIFFERENT, smaller history. Exists so "user A never sees user B's data"
    // can be verified against real rows rather than asserted.
    email: "dev-bob@example.com",
    name: "Dev Bob",
    solved: ["dev-cf-1", "dev-cf-3", "dev-lc-1"],
    attempted: [
      ["dev-cf-12", 2],
      ["dev-lc-7", 1],
    ],
  },
  {
    // ZERO UserProblem rows — the cold-start case. Every stage of the pipeline
    // produces nothing for this user, which is exactly the point.
    email: "dev-newbie@example.com",
    name: "Dev Newbie",
    solved: [],
    attempted: [],
  },
];

// Fixed timestamps rather than `new Date()` per row, so two runs of this seed
// write identical data. Solve history is historical, so a fixed date is also
// the honest representation.
const SOLVED_AT = new Date("2026-07-01T12:00:00.000Z");

async function main() {
  // --- topics: looked up, never created ------------------------------------
  const topics = await prisma.topic.findMany({ select: { id: true, slug: true } });
  const topicIdBySlug = new Map(topics.map((topic) => [topic.slug, topic.id]));

  const requiredSlugs = new Set(PROBLEMS.flatMap((p) => p.topicSlugs));
  for (const slug of requiredSlugs) {
    if (!topicIdBySlug.has(slug)) {
      throw new Error(
        `Topic "${slug}" is missing. Run \`npm run prisma:seed\` first — this ` +
          `script never creates topics.`
      );
    }
  }

  // --- problems + their topic links ----------------------------------------
  const problemIdByExternalId = new Map<string, string>();

  for (const seedProblem of PROBLEMS) {
    const problem = await prisma.problem.upsert({
      where: {
        provider_externalId: {
          provider: seedProblem.provider,
          externalId: seedProblem.externalId,
        },
      },
      update: {
        title: seedProblem.title,
        difficultyRaw: seedProblem.difficultyRaw,
        difficultyBand: seedProblem.difficultyBand,
      },
      create: {
        provider: seedProblem.provider,
        externalId: seedProblem.externalId,
        title: seedProblem.title,
        url: `https://example.invalid/dev/${seedProblem.externalId}`,
        difficultyRaw: seedProblem.difficultyRaw,
        difficultyBand: seedProblem.difficultyBand,
      },
    });

    problemIdByExternalId.set(seedProblem.externalId, problem.id);

    for (const slug of seedProblem.topicSlugs) {
      const topicId = topicIdBySlug.get(slug)!;
      // Upsert on the compound primary key. `create` would throw on the second
      // run; the pair IS the identity of the row, so there is nothing to update.
      await prisma.problemTopic.upsert({
        where: { problemId_topicId: { problemId: problem.id, topicId } },
        update: {},
        create: { problemId: problem.id, topicId },
      });
    }
  }

  // --- users + their solve history ------------------------------------------
  const passwordHash = await bcrypt.hash(DEV_PASSWORD, 10);

  for (const seedUser of USERS) {
    const user = await prisma.user.upsert({
      where: { email: seedUser.email },
      // Password left alone on re-run so an existing dev session keeps working.
      update: { name: seedUser.name },
      create: {
        email: seedUser.email,
        name: seedUser.name,
        password: passwordHash,
      },
    });

    for (const externalId of seedUser.solved) {
      const problemId = problemIdByExternalId.get(externalId)!;
      await prisma.userProblem.upsert({
        where: { userId_problemId: { userId: user.id, problemId } },
        update: {
          status: SolveStatus.SOLVED,
          solvedAt: SOLVED_AT,
          lastAttemptedAt: SOLVED_AT,
        },
        create: {
          userId: user.id,
          problemId,
          status: SolveStatus.SOLVED,
          attemptCount: 1,
          solvedAt: SOLVED_AT,
          lastAttemptedAt: SOLVED_AT,
        },
      });
    }

    for (const [externalId, attemptCount] of seedUser.attempted) {
      const problemId = problemIdByExternalId.get(externalId)!;
      await prisma.userProblem.upsert({
        where: { userId_problemId: { userId: user.id, problemId } },
        update: {
          status: SolveStatus.ATTEMPTED,
          attemptCount,
          // solvedAt stays null while the status is ATTEMPTED.
          solvedAt: null,
          lastAttemptedAt: SOLVED_AT,
        },
        create: {
          userId: user.id,
          problemId,
          status: SolveStatus.ATTEMPTED,
          attemptCount,
          lastAttemptedAt: SOLVED_AT,
        },
      });
    }

    // Revision items for everything solved. Deliberately does NOT recompute
    // mastery — that is left for POST /api/mastery/recompute to do, so the
    // endpoint's effect is visible rather than pre-applied here.
    await syncRevisionSchedule(user.id);
  }

  // --- back-date three of Alice's revision items ----------------------------
  //
  // syncRevisionSchedule schedules everything one day out, so nothing would be
  // due yet and GET /api/revision/due would be empty. Three items are pushed
  // into the past so "due" has real content, and everything else stays in the
  // future so "only items actually due appear" is a meaningful assertion.
  //
  // All three get the IDENTICAL dueAt on purpose: that forces the ordering to
  // fall through to the problemId tie-breaker, so the determinism check is
  // actually testing the tie-breaker rather than three conveniently distinct
  // timestamps.
  const alice = await prisma.user.findUnique({
    where: { email: "dev-alice@example.com" },
    select: { id: true },
  });

  if (alice) {
    const dueAt = new Date("2026-08-01T09:00:00.000Z");
    const overdueExternalIds = ["dev-cf-1", "dev-lc-1", "dev-lc-2"];

    for (const externalId of overdueExternalIds) {
      const problemId = problemIdByExternalId.get(externalId)!;
      await prisma.revisionItem.update({
        where: { userId_problemId: { userId: alice.id, problemId } },
        data: { dueAt, intervalDays: 1, repetitionCount: 0 },
      });
    }
  }

  const [problemCount, userProblemCount, revisionCount, topicCount] =
    await Promise.all([
      prisma.problem.count(),
      prisma.userProblem.count(),
      prisma.revisionItem.count(),
      prisma.topic.count(),
    ]);

  console.log("Dev seed complete.");
  console.log(`  users:        ${USERS.length} (password: ${DEV_PASSWORD})`);
  console.log(`  problems:     ${problemCount}`);
  console.log(`  userProblems: ${userProblemCount}`);
  console.log(`  revisionItems:${revisionCount}`);
  console.log(`  topics:       ${topicCount} (untouched by this script)`);
}

main()
  .catch((error) => {
    console.error("Dev seed failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
