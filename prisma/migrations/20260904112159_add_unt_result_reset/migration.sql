-- CreateTable
CREATE TABLE "UntResultReset" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "untId" TEXT NOT NULL,
    "untName" TEXT,
    "resultId" TEXT NOT NULL,
    "studentEmail" TEXT,
    "studentName" TEXT,
    "finishTimeWas" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UntResultReset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UntResultReset_at_idx" ON "UntResultReset"("at");

-- CreateIndex
CREATE INDEX "UntResultReset_resultId_idx" ON "UntResultReset"("resultId");
