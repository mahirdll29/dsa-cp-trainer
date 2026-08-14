import prisma from "../src/lib/prisma";

// ---------------------------------------------------------------------------
// Teardown for prisma/dev-seed.ts. Removes ONLY the fabricated rows and leaves
// the 32 production topics untouched.
//
// THE DELETION ORDER IS FORCED BY THE SCHEMA, not by preference:
//
//   Problem -> UserProblem and Problem -> RevisionItem are onDelete: Restrict
//   (architecture.md 2.3), because a Problem is shared reference data and
//   deleting one must never silently erase somebody's real solve history.
//
// So the dev problems CANNOT be deleted while any UserProblem or RevisionItem
// points at them. Deleting the dev users first clears those rows by Cascade,
// after which the problems are free.
//
// Attempting it the other way round raises PostgreSQL 23001, which — per the
// Module 1 finding — Prisma does NOT map to a P-code: it surfaces as
// PrismaClientUnknownRequestError with error.code === undefined.
// ---------------------------------------------------------------------------

async function main() {
  // Cascades UserProblem, TopicMastery, RevisionItem and LinkedAccount.
  const users = await prisma.user.deleteMany({
    where: { email: { startsWith: "dev-" } },
  });

  // Cascades ProblemTopic.
  const problems = await prisma.problem.deleteMany({
    where: { externalId: { startsWith: "dev-" } },
  });

  const [topicCount, problemCount, userProblemCount, revisionCount, masteryCount] =
    await Promise.all([
      prisma.topic.count(),
      prisma.problem.count(),
      prisma.userProblem.count(),
      prisma.revisionItem.count(),
      prisma.topicMastery.count(),
    ]);

  console.log("Dev seed cleaned.");
  console.log(`  deleted users:    ${users.count}`);
  console.log(`  deleted problems: ${problems.count}`);
  console.log("  remaining:");
  console.log(`    topics:        ${topicCount}  (expected 32)`);
  console.log(`    problems:      ${problemCount}`);
  console.log(`    userProblems:  ${userProblemCount}`);
  console.log(`    revisionItems: ${revisionCount}`);
  console.log(`    topicMastery:  ${masteryCount}`);
}

main()
  .catch((error) => {
    console.error("Dev seed clean failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
