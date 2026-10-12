ALTER TABLE "AppSetting" ADD COLUMN "parentAccessBotEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "PendingParentAccess" (
  "id" TEXT NOT NULL,
  "issueId" TEXT NOT NULL,
  "parentId" TEXT NOT NULL,
  "account" JSONB NOT NULL,
  "recipientId" TEXT NOT NULL,
  "dmMessageId" INTEGER,
  "targetChatId" TEXT NOT NULL,
  "targetMessageId" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PendingParentAccess_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PendingParentAccess_status_check" CHECK ("status" IN ('PENDING', 'PROCESSING', 'SENT', 'DECLINED', 'FAILED', 'UNCERTAIN', 'DELIVERY_FAILED'))
);
CREATE UNIQUE INDEX "PendingParentAccess_issueId_parentId_key" ON "PendingParentAccess"("issueId", "parentId");
CREATE INDEX "PendingParentAccess_status_createdAt_idx" ON "PendingParentAccess"("status", "createdAt");
