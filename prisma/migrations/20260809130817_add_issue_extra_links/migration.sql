-- AlterTable
ALTER TABLE "Issue" ADD COLUMN     "extraLinks" TEXT[] DEFAULT ARRAY[]::TEXT[];
