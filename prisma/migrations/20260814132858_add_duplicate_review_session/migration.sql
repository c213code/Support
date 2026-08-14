-- CreateTable
CREATE TABLE "DuplicateReviewSession" (
    "chatId" TEXT NOT NULL,
    "reportDate" TEXT NOT NULL,
    "messageId" INTEGER NOT NULL,
    "groupsJson" TEXT NOT NULL,
    "currentIndex" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DuplicateReviewSession_pkey" PRIMARY KEY ("chatId")
);
