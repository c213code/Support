-- CreateTable
CREATE TABLE "SubmissionMessage" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "fromAgent" BOOLEAN NOT NULL,
    "authorName" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "photoFileIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "telegramMessageId" INTEGER,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubmissionMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingCuratorMessage" (
    "id" TEXT NOT NULL,
    "telegramUserId" BIGINT NOT NULL,
    "chatId" TEXT NOT NULL,
    "promptMessageId" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "photoFileIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingCuratorMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SubmissionMessage_submissionId_createdAt_idx" ON "SubmissionMessage"("submissionId", "createdAt");

-- CreateIndex
CREATE INDEX "SubmissionMessage_telegramMessageId_idx" ON "SubmissionMessage"("telegramMessageId");

-- CreateIndex
CREATE INDEX "PendingCuratorMessage_telegramUserId_createdAt_idx" ON "PendingCuratorMessage"("telegramUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PendingCuratorMessage_chatId_promptMessageId_key" ON "PendingCuratorMessage"("chatId", "promptMessageId");

-- AddForeignKey
ALTER TABLE "SubmissionMessage" ADD CONSTRAINT "SubmissionMessage_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "IssueSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

