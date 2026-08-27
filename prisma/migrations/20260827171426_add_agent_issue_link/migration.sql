-- AlterTable
ALTER TABLE "TelegramMessage" ADD COLUMN     "agentIssueId" TEXT;

-- CreateIndex
CREATE INDEX "TelegramMessage_chatId_receivedAt_idx" ON "TelegramMessage"("chatId", "receivedAt");
