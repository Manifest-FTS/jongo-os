-- Custom staging domains (docs/architecture/custom-staging-domains.md).
-- Additive only.

CREATE TABLE "StagingDomain" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "siteId" UUID NOT NULL,
    "hostname" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending_dns',
    "sslStatus" TEXT NOT NULL DEFAULT 'none',
    "cnameTarget" TEXT NOT NULL,
    "lastError" TEXT,
    "lastErrorReason" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "attachedAt" TIMESTAMP(3),
    "sslIssuedAt" TIMESTAMP(3),
    "sslExpiresAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StagingDomain_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StagingDomain_siteId_idx" ON "StagingDomain"("siteId");
CREATE INDEX "StagingDomain_hostname_idx" ON "StagingDomain"("hostname");
CREATE INDEX "StagingDomain_status_idx" ON "StagingDomain"("status");

-- One live claim per hostname across the whole platform. Removed rows are kept
-- for audit and do not hold the name.
CREATE UNIQUE INDEX "StagingDomain_live_hostname_key" ON "StagingDomain"(lower("hostname")) WHERE "status" <> 'removed';

ALTER TABLE "StagingDomain" ADD CONSTRAINT "StagingDomain_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
