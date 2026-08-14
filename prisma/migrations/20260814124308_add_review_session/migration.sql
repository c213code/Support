-- CreateTable
CREATE TABLE "ReviewSession" (
    "chatId" TEXT NOT NULL,
    "reportDate" TEXT NOT NULL,
    "messageId" INTEGER NOT NULL,
    "ticketIds" TEXT[],
    "currentIndex" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewSession_pkey" PRIMARY KEY ("chatId")
);
