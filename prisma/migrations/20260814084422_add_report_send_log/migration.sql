-- CreateTable
CREATE TABLE "ReportSendLog" (
    "reportDate" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportSendLog_pkey" PRIMARY KEY ("reportDate")
);
