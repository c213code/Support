-- DropIndex
DROP INDEX "IssueSubmission_issueId_key";

-- CreateIndex
CREATE INDEX "IssueSubmission_issueId_idx" ON "IssueSubmission"("issueId");

