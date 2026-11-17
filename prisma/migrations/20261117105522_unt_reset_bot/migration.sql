-- AlterTable
ALTER TABLE "AppSetting" ADD COLUMN     "untResetBotEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "PendingUntReset" (
    "id" TEXT NOT NULL,
    "resultId" TEXT NOT NULL,
    "untId" TEXT NOT NULL,
    "untName" TEXT NOT NULL,
    "studentName" TEXT NOT NULL,
    "studentEmail" TEXT,
    "score" INTEGER NOT NULL,
    "matchedBy" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "dmMessageId" INTEGER,
    "sourceChatId" TEXT NOT NULL,
    "sourceMessageId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingUntReset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PendingUntReset_resultId_key" ON "PendingUntReset"("resultId");

-- CreateIndex
CREATE INDEX "PendingUntReset_status_createdAt_idx" ON "PendingUntReset"("status", "createdAt");

