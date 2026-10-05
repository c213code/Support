-- AlterTable
ALTER TABLE "Issue" ADD COLUMN     "handoffAt" TIMESTAMP(3),
ADD COLUMN     "handoffLink" TEXT;

-- AlterTable
ALTER TABLE "TelegramMessage" ADD COLUMN     "fromUsername" TEXT,
ADD COLUMN     "threadId" INTEGER;

