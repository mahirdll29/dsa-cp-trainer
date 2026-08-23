-- CreateEnum
CREATE TYPE "ContestStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'ABANDONED');

-- CreateTable
CREATE TABLE "ContestSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationMinutes" INTEGER NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" "ContestStatus" NOT NULL DEFAULT 'ACTIVE',
    "finalizedAt" TIMESTAMP(3),
    "reconciledAt" TIMESTAMP(3),

    CONSTRAINT "ContestSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContestProblem" (
    "id" TEXT NOT NULL,
    "contestSessionId" TEXT NOT NULL,
    "problemId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "claimedSolvedAt" TIMESTAMP(3),
    "confirmedSolvedAt" TIMESTAMP(3),

    CONSTRAINT "ContestProblem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContestSession_userId_status_idx" ON "ContestSession"("userId", "status");

-- CreateIndex
CREATE INDEX "ContestSession_userId_startedAt_idx" ON "ContestSession"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "ContestProblem_problemId_idx" ON "ContestProblem"("problemId");

-- CreateIndex
CREATE UNIQUE INDEX "ContestProblem_contestSessionId_position_key" ON "ContestProblem"("contestSessionId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ContestProblem_contestSessionId_problemId_key" ON "ContestProblem"("contestSessionId", "problemId");

-- AddForeignKey
ALTER TABLE "ContestSession" ADD CONSTRAINT "ContestSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContestProblem" ADD CONSTRAINT "ContestProblem_contestSessionId_fkey" FOREIGN KEY ("contestSessionId") REFERENCES "ContestSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContestProblem" ADD CONSTRAINT "ContestProblem_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "Problem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
