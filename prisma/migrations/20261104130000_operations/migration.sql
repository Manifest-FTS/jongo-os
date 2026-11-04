-- Operations log: one row per long-running task (deploy, provision, backup,
-- restore, migration). See the Operation model in schema.prisma.

-- CreateEnum
CREATE TYPE "OperationStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

-- CreateTable
CREATE TABLE "Operation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID,
    "actorId" UUID,
    "kind" TEXT NOT NULL,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "status" "OperationStatus" NOT NULL DEFAULT 'queued',
    "idempotencyKey" TEXT,
    "input" JSONB,
    "steps" JSONB,
    "result" JSONB,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "jobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Operation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Operation_idempotencyKey_key" ON "Operation"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Operation_organizationId_createdAt_idx" ON "Operation"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "Operation_resourceType_resourceId_idx" ON "Operation"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "Operation_status_idx" ON "Operation"("status");

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
