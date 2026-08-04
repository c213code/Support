-- CreateEnum
CREATE TYPE "IssueStatus" AS ENUM ('RESOLVED', 'PENDING');

-- CreateTable
CREATE TABLE "GroupPreset" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "emoji" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupPreset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Issue" (
    "id" TEXT NOT NULL,
    "reportDate" TEXT NOT NULL,
    "groupName" TEXT NOT NULL,
    "groupEmoji" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL,
    "telegramLink" TEXT,
    "status" "IssueStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "ticketLink" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Issue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GroupPreset_name_key" ON "GroupPreset"("name");

-- CreateIndex
CREATE INDEX "Issue_reportDate_idx" ON "Issue"("reportDate");
