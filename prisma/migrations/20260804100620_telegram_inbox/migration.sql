-- AlterTable
ALTER TABLE "GroupPreset" ADD COLUMN     "chatId" TEXT;

-- CreateTable
CREATE TABLE "TelegramMessage" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "messageId" INTEGER NOT NULL,
    "chatTitle" TEXT,
    "groupName" TEXT,
    "groupEmoji" TEXT,
    "authorName" TEXT,
    "text" TEXT,
    "messageLink" TEXT NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "usedForIssueId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TelegramMessage_archived_receivedAt_idx" ON "TelegramMessage"("archived", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramMessage_chatId_messageId_key" ON "TelegramMessage"("chatId", "messageId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupPreset_chatId_key" ON "GroupPreset"("chatId");
