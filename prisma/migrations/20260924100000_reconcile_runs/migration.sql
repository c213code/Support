-- CreateTable
CREATE TABLE "ReconcileRun" (
    "id" TEXT NOT NULL,
    "reportDate" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "startedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ReconcileRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconcileVerdict" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "statusBefore" "IssueStatus" NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "proposed" TEXT,
    "note" TEXT,
    "evidence" TEXT,
    "resolver" TEXT,
    "error" TEXT,
    "appliedAt" TIMESTAMP(3),
    "appliedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconcileVerdict_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReconcileRun_reportDate_idx" ON "ReconcileRun"("reportDate");

-- CreateIndex
CREATE INDEX "ReconcileVerdict_runId_idx" ON "ReconcileVerdict"("runId");

-- CreateIndex
CREATE INDEX "ReconcileVerdict_issueId_idx" ON "ReconcileVerdict"("issueId");

-- AddForeignKey
ALTER TABLE "ReconcileVerdict" ADD CONSTRAINT "ReconcileVerdict_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ReconcileRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconcileVerdict" ADD CONSTRAINT "ReconcileVerdict_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

