-- AlterTable
ALTER TABLE "TelegramMessage" ADD COLUMN     "photoFileId" TEXT;

-- CreateTable
CREATE TABLE "DevJiraAccount" (
    "telegramId" BIGINT NOT NULL,
    "accountId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DevJiraAccount_pkey" PRIMARY KEY ("telegramId")
);

