-- Staging databases for apps (docs/superpowers/specs/2026-10-13-staging-databases-design.md).
-- Additive only.

CREATE TABLE "StagingDatabase" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "siteId" UUID NOT NULL,
    "productionDbUuid" TEXT NOT NULL,
    "productionDbName" TEXT NOT NULL,
    "stagingDbUuid" TEXT,
    "engine" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'creating',
    "lastCopiedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "tableCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "StagingDatabase_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StagingDatabase_siteId_idx" ON "StagingDatabase"("siteId");
-- One live staging copy per production database per site.
CREATE UNIQUE INDEX "StagingDatabase_live_key" ON "StagingDatabase"("siteId", "productionDbUuid") WHERE "status" <> 'removed';

ALTER TABLE "StagingDatabase" ADD CONSTRAINT "StagingDatabase_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- External data services (Sanity, Neon, …) staging shares with production.
ALTER TABLE "Site" ADD COLUMN "stagingSharedServices" TEXT;
