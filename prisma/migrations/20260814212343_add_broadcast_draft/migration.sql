-- CreateTable
CREATE TABLE "BroadcastDraft" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BroadcastDraft_pkey" PRIMARY KEY ("id")
);
