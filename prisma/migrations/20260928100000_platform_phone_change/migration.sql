-- CreateTable
CREATE TABLE "PlatformPhoneChange" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "studentName" TEXT,
    "oldPhone" TEXT NOT NULL,
    "newPhone" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformPhoneChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlatformPhoneChange_at_idx" ON "PlatformPhoneChange"("at");

-- CreateIndex
CREATE INDEX "PlatformPhoneChange_studentId_at_idx" ON "PlatformPhoneChange"("studentId", "at");
