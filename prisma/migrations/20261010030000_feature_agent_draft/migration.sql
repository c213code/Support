CREATE TABLE "FeatureAgentDraft" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "issueUpdatedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "feature" TEXT,
    "summary" TEXT NOT NULL,
    "draft" TEXT NOT NULL,
    "evidence" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "missingData" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "ruleIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "sourcePaths" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "queries" JSONB NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeatureAgentDraft_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FeatureAgentDraft_issueId_key" ON "FeatureAgentDraft"("issueId");
CREATE INDEX "FeatureAgentDraft_updatedAt_idx" ON "FeatureAgentDraft"("updatedAt");

ALTER TABLE "FeatureAgentDraft" ADD CONSTRAINT "FeatureAgentDraft_issueId_fkey"
FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
