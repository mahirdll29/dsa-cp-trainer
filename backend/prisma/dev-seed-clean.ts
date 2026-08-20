import prisma from "../src/lib/prisma";

// DELETION ORDER IS FORCED BY THE SCHEMA. Problem -> UserProblem and
// Problem -> RevisionItem are onDelete: Restrict, so the dev problems cannot be
// deleted while any solve or revision row points at them. Deleting the dev users
// first clears those by Cascade. The other order raises PostgreSQL 23001, which
// Prisma does NOT map to a P-code - it surfaces as PrismaClientUnknownRequestError
// with error.code undefined.

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
