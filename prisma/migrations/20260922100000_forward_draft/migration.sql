-- CreateTable
CREATE TABLE "ForwardDraft" (
    "id" TEXT NOT NULL,
    "telegramUserId" BIGINT NOT NULL,
    "text" TEXT NOT NULL,
    "photoFileIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "promptChatId" TEXT,
    "promptMessageId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ForwardDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ForwardDraft_telegramUserId_key" ON "ForwardDraft"("telegramUserId");

