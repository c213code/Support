CREATE TABLE "LocalFeatureAgentControl" (
    "id" TEXT NOT NULL DEFAULT 'local',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3),
    "currentIssueId" TEXT,
    "model" TEXT,
    "reasoning" TEXT,
    "runsDate" TEXT,
    "runsCount" INTEGER NOT NULL DEFAULT 0,
    "dailyLimit" INTEGER NOT NULL DEFAULT 20,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LocalFeatureAgentControl_pkey" PRIMARY KEY ("id")
);
