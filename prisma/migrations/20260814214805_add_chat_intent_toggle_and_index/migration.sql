-- AlterTable
ALTER TABLE "AppSetting" ADD COLUMN     "chatIntentEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Issue_status_reportDate_idx" ON "Issue"("status", "reportDate");
