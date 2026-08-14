-- AlterTable
ALTER TABLE "AppSetting" ADD COLUMN     "autoReplyEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "BotReply" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "messageId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotReply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BotReply_issueId_idx" ON "BotReply"("issueId");

-- CreateIndex
CREATE UNIQUE INDEX "BotReply_chatId_messageId_key" ON "BotReply"("chatId", "messageId");
