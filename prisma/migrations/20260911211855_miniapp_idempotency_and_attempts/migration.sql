
-- AlterTable
ALTER TABLE "IssueSubmission" ADD COLUMN     "clientSubmissionId" TEXT;

-- CreateTable
CREATE TABLE "MiniAppAttempt" (
    "id" TEXT NOT NULL,
    "telegramUserId" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MiniAppAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MiniAppAttempt_telegramUserId_createdAt_idx" ON "MiniAppAttempt"("telegramUserId", "createdAt");

-- CreateIndex
CREATE INDEX "MiniAppAttempt_createdAt_idx" ON "MiniAppAttempt"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IssueSubmission_clientSubmissionId_key" ON "IssueSubmission"("clientSubmissionId");
