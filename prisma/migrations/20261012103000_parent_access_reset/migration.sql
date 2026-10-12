CREATE TABLE "ParentAccessReset" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "parentId" TEXT NOT NULL,
    "studentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'STARTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ParentAccessReset_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ParentAccessReset_status_check" CHECK ("status" IN ('STARTED', 'SUCCESS', 'UNCERTAIN'))
);
CREATE INDEX "ParentAccessReset_parentId_createdAt_idx" ON "ParentAccessReset"("parentId", "createdAt");
CREATE INDEX "ParentAccessReset_createdAt_idx" ON "ParentAccessReset"("createdAt");
