-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('ACTIVE', 'SOLVED', 'ABANDONED');

-- CreateTable
CREATE TABLE "PracticeSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "problemId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "status" "SessionStatus" NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "PracticeSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionHint" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionHint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PracticeSession_userId_status_idx" ON "PracticeSession"("userId", "status");

-- CreateIndex
CREATE INDEX "PracticeSession_userId_startedAt_idx" ON "PracticeSession"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "PracticeSession_problemId_idx" ON "PracticeSession"("problemId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionHint_sessionId_level_key" ON "SessionHint"("sessionId", "level");

-- AddForeignKey
ALTER TABLE "PracticeSession" ADD CONSTRAINT "PracticeSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeSession" ADD CONSTRAINT "PracticeSession_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "Problem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionHint" ADD CONSTRAINT "SessionHint_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "PracticeSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
