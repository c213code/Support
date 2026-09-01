-- CreateTable
CREATE TABLE "PlatformEmailChange" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "studentName" TEXT,
    "oldEmail" TEXT NOT NULL,
    "newEmail" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformEmailChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlatformEmailChange_at_idx" ON "PlatformEmailChange"("at");

-- CreateIndex
CREATE INDEX "PlatformEmailChange_studentId_at_idx" ON "PlatformEmailChange"("studentId", "at");
