import "dotenv/config";
import prisma from "../src/lib/prisma";
import { syncLeetcodeCatalog } from "../src/providers/leetcode/sync";

// npm run sync:lc-problems [-- --skip=N]
//
// Imports the free LeetCode catalog as shared reference data. For this provider the
// catalog is the valuable half: /problems gives ~3,240 tagged, graded problems while
// the user-history endpoint gives at most 20 rows. It also fills the eleven topics
// Codeforces leaves empty.
//
// Requires `npm run prisma:seed` first. Safe to re-run.
//
// Writes are committed PER PAGE, so an interrupted run has already persisted
// everything up to the interruption and --skip=N resumes instead of restarting.
// The per-page log line prints the skip value to use.

// Hand-parsed: one flag does not justify a CLI argument dependency.
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
  // Stated up front because it is not obvious and it bites: the wrapper allows 120
  // requests per HOUR per IP and a full run spends ~41 of them.
  console.log("(a full run uses ~41 of the API's 120 requests/hour budget)");
  if (startSkip > 0) console.log(`Resuming from skip=${startSkip}\n`);
  else console.log("");

  const result = await syncLeetcodeCatalog(startSkip, ({ page, skip, got, total }) => {
    // Per-page progress, so an interrupted run tells you where to resume from.
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
