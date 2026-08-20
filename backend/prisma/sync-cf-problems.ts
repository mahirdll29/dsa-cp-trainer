import "dotenv/config";
import prisma from "../src/lib/prisma";
import { syncCodeforcesCatalog } from "../src/providers/codeforces/sync";

// npm run sync:cf-problems
//
// Imports the entire Codeforces problemset as shared reference data - the candidate
// pool the engine picks from. A script rather than an endpoint because the data is
// identical for every user and owned by nobody.
//
// Requires `npm run prisma:seed` first: with no Topic rows every problem imports
// with zero topics and is invisible to the engine. Safe to re-run, which is also
// the recovery path if a run dies partway.

async function main() {
  console.log("Syncing the Codeforces problemset...\n");

  const result = await syncCodeforcesCatalog();

  console.log("\n--- catalog sync complete ---");
  console.log(`  fetched from API      ${result.fetched}`);
  console.log(`  malformed (skipped)   ${result.malformed}`);
  console.log(`  skipped: unrated      ${result.skippedUnrated}`);
  console.log(`  skipped: no contestId ${result.skippedNoContestId}`);
  console.log(`  problems created      ${result.problemsCreated}`);
  console.log(`  problems updated      ${result.problemsUpdated}`);
  console.log(`  topic links created   ${result.topicLinksCreated}`);
  console.log(`  topic links deleted   ${result.topicLinksDeleted}`);
  console.log(`  imported with 0 topics ${result.problemsWithNoTopic}`);
  console.log(`  duration              ${(result.durationMs / 1000).toFixed(1)} s`);
}

main()
  .catch((error) => {
    console.error("Catalog sync failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
