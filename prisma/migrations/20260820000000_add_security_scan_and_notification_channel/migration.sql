-- Adds the two models that reached prisma/schema.prisma in "Automate Malware
-- Detection" (62b6feb) without a migration, so they never existed in any
-- deployed database. Every write to them failed at runtime:
--   * SecurityScanResult  — POST /api/internal/v1/security/scan-report threw,
--                           so no malware/integrity scan was ever recorded.
--   * NotificationChannel — per-organization Slack/email routing. The backup
--                           recorder catches the failure and falls back to the
--                           platform webhook, so org-specific channels were
--                           silently inert rather than loudly broken.
--
-- ADDITIVE ONLY, deliberately. `migrate diff` against production also proposes
-- dropping two indexes (OrganizationCoolifyProjectLink_deletedAt_idx,
-- Site_parentSiteId_idx) and dropping DEFAULTs on five columns. That drift is
-- older, comes from applying schema changes with `db push`, and is unrelated to
-- these tables — folding it in here would make a routine fix quietly destructive.

-- CreateEnum
CREATE TYPE "SecurityFindingSeverity" AS ENUM ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateTable
CREATE TABLE "SecurityScanResult" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "resourceId" UUID NOT NULL,
    "resourceType" TEXT NOT NULL DEFAULT 'site',
    "jobId" TEXT,
    "environment" TEXT NOT NULL,
    "scanner" TEXT NOT NULL,
    "scannerMeta" JSONB,
    "scanType" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "filesScanned" INTEGER NOT NULL,
    "findings" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "errorDetails" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityScanResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationChannel" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "minimumSeverity" "SecurityFindingSeverity" NOT NULL DEFAULT 'MEDIUM',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationChannel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SecurityScanResult_resourceId_createdAt_idx" ON "SecurityScanResult"("resourceId", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityScanResult_status_idx" ON "SecurityScanResult"("status");

-- CreateIndex
CREATE INDEX "NotificationChannel_organizationId_idx" ON "NotificationChannel"("organizationId");

-- AddForeignKey
ALTER TABLE "NotificationChannel" ADD CONSTRAINT "NotificationChannel_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
