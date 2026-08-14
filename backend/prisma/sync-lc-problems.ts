import "dotenv/config";
import prisma from "../src/lib/prisma";
import { syncLeetcodeCatalog } from "../src/providers/leetcode/sync";

// ---------------------------------------------------------------------------
// npm run sync:lc-problems  [-- --skip=N]
//
// Imports the free LeetCode problem catalog as shared reference data. This is
// the CANDIDATE POOL the recommendation engine picks from, and for this module
// it is the valuable half: /problems gives 3,240 fully-tagged, difficulty-
// graded problems, while the user-history endpoint gives at most 20 rows.
//
// It also fills the ELEVEN topics Codeforces left with zero problems (arrays,
// sliding-window, prefix-sum, stack, queue, linked-list, backtracking,
// binary-search-tree, heap, breadth-first-search, segment-tree), which is what
// revives the recommendation engine's exploratory stage.
//
// WHY THIS IS A SCRIPT AND NOT AN HTTP ENDPOINT. The data is global: identical
// for every user, owned by nobody, unrelated to any LinkedAccount. Putting it
// behind requireAuth would imply it belonged to whoever triggered it. Same
// category of job as prisma:seed, which is why it lives here beside seed.ts.
//
// PREREQUISITE: `npm run prisma:seed` must have run first. With no Topic rows
// every problem would import with zero topics — invisible to the engine. The
// sync throws rather than letting that happen quietly.
//
// SAFE TO RE-RUN. Every write is keyed on a natural unique, so a second run
// creates nothing. That is also the recovery path if a run dies partway.
//
// RESUMING. Unlike the Codeforces catalog (one API call), this one is 41
// paginated requests and takes minutes. Writes are committed PER PAGE, so an
// interrupted run has already persisted everything up to the interruption:
//
//     npm run sync:lc-problems -- --skip=2000
//
// picks up at page 21 instead of starting over. The per-page log line prints
// the skip value to use.
// ---------------------------------------------------------------------------

// Hand-parsed rather than pulling in a CLI argument library — one flag does not
// justify a dependency, and this matches the project's no-Zod, no-framework
// posture on small parsing jobs.
function parseStartSkip(argv: string[]): number {
  const flag = argv.find((a) => a.startsWith("--skip="));
  if (!flag) return 0;

  const value = Number(flag.slice("--skip=".length));
  if (!Number.isInteger(value) || value < 0) {
    console.error(`Invalid --skip value: ${flag}. Expected a non-negative integer.`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const startSkip = parseStartSkip(process.argv.slice(2));

  console.log("Syncing the LeetCode problem catalog...");
  // THE OPERATIONAL CONSTRAINT, stated up front because it is not obvious and
  // it bites: the wrapper allows 120 requests per HOUR per IP, and a full run
  // spends about 41 of them. Two runs in an hour is fine; three is not.
  console.log("(a full run uses ~41 of the API's 120 requests/hour budget)");
  if (startSkip > 0) console.log(`Resuming from skip=${startSkip}\n`);
  else console.log("");

  const result = await syncLeetcodeCatalog(startSkip, ({ page, skip, got, total }) => {
    // Progress per page, so an interrupted run tells you where to resume from
    // rather than leaving you to work it out.
    const seen = skip + got;
    console.log(
      `  page ${String(page).padStart(3)}  skip=${String(skip).padStart(5)}  ` +
        `got=${String(got).padStart(3)}  ${seen}/${total}`
    );
  });

  console.log("\n--- LeetCode catalog sync complete ---");
  console.log(`  pages fetched          ${result.pages}`);
  console.log(`  problems fetched       ${result.fetched}`);
  console.log(`  reported by API        ${result.totalReported}`);
  console.log(`  malformed (skipped)    ${result.malformed}`);
  console.log(`  skipped: premium       ${result.skippedPremium}`);
  console.log(`  problems created       ${result.problemsCreated}`);
  console.log(`  problems updated       ${result.problemsUpdated}`);
  console.log(`  topic links created    ${result.topicLinksCreated}`);
  console.log(`  topic links deleted    ${result.topicLinksDeleted}`);
  console.log(`  imported with 0 topics ${result.problemsWithNoTopic}`);
  console.log(`  duration               ${(result.durationMs / 1000).toFixed(1)} s`);
}

main()
  .catch((error) => {
    console.error("LeetCode catalog sync failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
