-- AlterTable
ALTER TABLE "AppSetting" ADD COLUMN     "handoffEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "TelegramMessage" ADD COLUMN     "hasMedia" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "PendingHandoff" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "messageId" INTEGER NOT NULL,
    "issueId" TEXT NOT NULL,
    "team" TEXT NOT NULL,
    "assigneeName" TEXT,
    "assigneeTgId" BIGINT,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "linkOptions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingHandoff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PendingHandoff_issueId_key" ON "PendingHandoff"("issueId");

-- CreateIndex
CREATE UNIQUE INDEX "PendingHandoff_chatId_messageId_key" ON "PendingHandoff"("chatId", "messageId");

-- AddForeignKey
ALTER TABLE "PendingHandoff" ADD CONSTRAINT "PendingHandoff_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

