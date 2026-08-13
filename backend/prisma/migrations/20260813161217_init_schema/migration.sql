-- CreateEnum
CREATE TYPE "Provider" AS ENUM ('LEETCODE', 'CODEFORCES');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('PENDING', 'SYNCING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "DifficultyBand" AS ENUM ('EASY', 'MEDIUM', 'HARD');

-- CreateEnum
CREATE TYPE "SolveStatus" AS ENUM ('SOLVED', 'ATTEMPTED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LinkedAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "handle" TEXT NOT NULL,
    "syncStatus" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinkedAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Topic" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Topic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Problem" (
    "id" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "difficultyRaw" TEXT NOT NULL,
    "difficultyBand" "DifficultyBand" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Problem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProblemTopic" (
    "problemId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,

    CONSTRAINT "ProblemTopic_pkey" PRIMARY KEY ("problemId","topicId")
);

-- CreateTable
CREATE TABLE "UserProblem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "problemId" TEXT NOT NULL,
    "status" "SolveStatus" NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 1,
    "solvedAt" TIMESTAMP(3),
    "lastAttemptedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserProblem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TopicMastery" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "solvedCount" INTEGER NOT NULL,
    "attemptedCount" INTEGER NOT NULL,
    "masteryScore" DOUBLE PRECISION NOT NULL,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TopicMastery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RatingChange" (
    "id" TEXT NOT NULL,
    "linkedAccountId" TEXT NOT NULL,
    "contestId" INTEGER NOT NULL,
    "contestName" TEXT NOT NULL,
    "oldRating" INTEGER NOT NULL,
    "newRating" INTEGER NOT NULL,
    "rank" INTEGER NOT NULL,
    "ratedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RatingChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevisionItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "problemId" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "intervalDays" INTEGER NOT NULL,
    "repetitionCount" INTEGER NOT NULL,
    "lastReviewedAt" TIMESTAMP(3),

    CONSTRAINT "RevisionItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "LinkedAccount_userId_provider_key" ON "LinkedAccount"("userId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "Topic_name_key" ON "Topic"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Topic_slug_key" ON "Topic"("slug");

-- CreateIndex
CREATE INDEX "Problem_difficultyBand_idx" ON "Problem"("difficultyBand");

-- CreateIndex
CREATE UNIQUE INDEX "Problem_provider_externalId_key" ON "Problem"("provider", "externalId");

-- CreateIndex
CREATE INDEX "ProblemTopic_topicId_idx" ON "ProblemTopic"("topicId");

-- CreateIndex
CREATE INDEX "UserProblem_problemId_idx" ON "UserProblem"("problemId");

-- CreateIndex
CREATE UNIQUE INDEX "UserProblem_userId_problemId_key" ON "UserProblem"("userId", "problemId");

-- CreateIndex
CREATE INDEX "TopicMastery_topicId_idx" ON "TopicMastery"("topicId");

-- CreateIndex
CREATE UNIQUE INDEX "TopicMastery_userId_topicId_key" ON "TopicMastery"("userId", "topicId");

-- CreateIndex
CREATE INDEX "RatingChange_linkedAccountId_ratedAt_idx" ON "RatingChange"("linkedAccountId", "ratedAt");

-- CreateIndex
CREATE INDEX "RevisionItem_userId_dueAt_idx" ON "RevisionItem"("userId", "dueAt");

-- CreateIndex
CREATE INDEX "RevisionItem_problemId_idx" ON "RevisionItem"("problemId");

-- CreateIndex
CREATE UNIQUE INDEX "RevisionItem_userId_problemId_key" ON "RevisionItem"("userId", "problemId");

-- AddForeignKey
ALTER TABLE "LinkedAccount" ADD CONSTRAINT "LinkedAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProblemTopic" ADD CONSTRAINT "ProblemTopic_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "Problem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProblemTopic" ADD CONSTRAINT "ProblemTopic_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserProblem" ADD CONSTRAINT "UserProblem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserProblem" ADD CONSTRAINT "UserProblem_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "Problem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopicMastery" ADD CONSTRAINT "TopicMastery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopicMastery" ADD CONSTRAINT "TopicMastery_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RatingChange" ADD CONSTRAINT "RatingChange_linkedAccountId_fkey" FOREIGN KEY ("linkedAccountId") REFERENCES "LinkedAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevisionItem" ADD CONSTRAINT "RevisionItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevisionItem" ADD CONSTRAINT "RevisionItem_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "Problem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
