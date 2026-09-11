-- CreateTable
CREATE TABLE "IssueSubmission" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "telegramUserId" BIGINT NOT NULL,
    "authorName" TEXT NOT NULL,
    "rawText" TEXT NOT NULL,
    "studentContact" TEXT NOT NULL,
    "lessonLink" TEXT NOT NULL,
    "photoFileId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssueSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IssueSubmission_issueId_key" ON "IssueSubmission"("issueId");

-- CreateIndex
CREATE INDEX "IssueSubmission_telegramUserId_createdAt_idx" ON "IssueSubmission"("telegramUserId", "createdAt");

-- AddForeignKey
ALTER TABLE "IssueSubmission" ADD CONSTRAINT "IssueSubmission_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
