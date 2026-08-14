import "dotenv/config";
import prisma from "../src/lib/prisma";
import { syncCodeforcesCatalog } from "../src/providers/codeforces/sync";

// ---------------------------------------------------------------------------
// npm run sync:cf-problems
//
// Imports the ENTIRE Codeforces problemset as shared reference data. This is
// the CANDIDATE POOL the recommendation engine picks from — the problems it
// suggests a user should solve NEXT.
//
// WHY THIS IS A SCRIPT AND NOT AN HTTP ENDPOINT. The data is global: identical
// for every user, owned by nobody, and unrelated to any LinkedAccount. Putting
// it behind requireAuth would imply it belonged to whoever triggered it. It is
// the same category of job as `prisma:seed`, which is why it lives here beside
// seed.ts and dev-seed.ts rather than under src/routes.
//
// PREREQUISITE: `npm run prisma:seed` must have run first. The tag mapping
// resolves Codeforces tags to Topic.slug, and with no Topic rows every problem
// would import with zero topics — invisible to the engine. The sync throws
// rather than letting that happen quietly.
//
// SAFE TO RE-RUN. Every write is keyed on a natural unique, so a second run
// creates nothing and is much faster than the first. That is also the recovery
// path if a run dies partway: just run it again.
// ---------------------------------------------------------------------------

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
