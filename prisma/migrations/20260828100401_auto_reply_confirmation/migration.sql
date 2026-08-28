-- AlterTable
ALTER TABLE "AppSetting" ADD COLUMN     "autoReplyConfirm" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "PendingAutoReply" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "messageId" INTEGER NOT NULL,
    "issueId" TEXT NOT NULL,
    "targetChatId" TEXT NOT NULL,
    "targetMessageId" INTEGER NOT NULL,
    "variants" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingAutoReply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PendingAutoReply_issueId_idx" ON "PendingAutoReply"("issueId");

-- CreateIndex
CREATE UNIQUE INDEX "PendingAutoReply_chatId_messageId_key" ON "PendingAutoReply"("chatId", "messageId");

-- AddForeignKey
ALTER TABLE "PendingAutoReply" ADD CONSTRAINT "PendingAutoReply_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
