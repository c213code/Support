-- AlterEnum
ALTER TYPE "IssueStatus" ADD VALUE 'ESCALATED';

-- AlterTable
ALTER TABLE "Issue" ADD COLUMN     "escalatedAssignee" TEXT,
ADD COLUMN     "escalatedTeam" TEXT;
