-- CreateTable
CREATE TABLE "MasteryLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "solvedCount" INTEGER NOT NULL,
    "attemptedCount" INTEGER NOT NULL,
    "masteryScore" DOUBLE PRECISION NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MasteryLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MasteryLog_userId_topicId_capturedAt_idx" ON "MasteryLog"("userId", "topicId", "capturedAt");

-- CreateIndex
CREATE INDEX "MasteryLog_topicId_idx" ON "MasteryLog"("topicId");

-- AddForeignKey
ALTER TABLE "MasteryLog" ADD CONSTRAINT "MasteryLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MasteryLog" ADD CONSTRAINT "MasteryLog_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
