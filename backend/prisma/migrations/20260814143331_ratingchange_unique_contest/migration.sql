-- CreateIndex
CREATE UNIQUE INDEX "RatingChange_linkedAccountId_contestId_key" ON "RatingChange"("linkedAccountId", "contestId");
