-- Revocation cleanup outbox. Revocation status and this immutable intent commit together.
-- Provider deletion and Cloudflare purge run only after that transaction commits.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
CREATE TYPE "CmsMediaCleanupStatus" AS ENUM ('pending', 'processing', 'complete');
CREATE TABLE "CmsMediaCleanupJob" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "datasetId" UUID NOT NULL,
  "mediaId" UUID NOT NULL,
  "objectKey" TEXT NOT NULL,
  "publicUrl" TEXT NOT NULL,
  "status" "CmsMediaCleanupStatus" NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseUntil" TIMESTAMP(3),
  "leaseToken" UUID,
  "lastError" TEXT,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CmsMediaCleanupJob_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "CmsDataset"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "CmsMediaCleanupJob_datasetId_mediaId_fkey" FOREIGN KEY ("datasetId", "mediaId") REFERENCES "CmsApprovedMedia"("datasetId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "CmsMediaCleanupJob_identity_check" CHECK (
    "objectKey" ~ ('^' || "datasetId"::text || '/' || "mediaId"::text || '/[0-9a-f]{64}[.]webp$')
    AND "publicUrl" = substring("publicUrl" FROM '^https://[^/]+') || '/assets/' || "objectKey"
    AND "publicUrl" ~ '^https://[^/]+/assets/'
  ),
  CONSTRAINT "CmsMediaCleanupJob_lease_check" CHECK (
    (("leaseUntil" IS NULL) = ("leaseToken" IS NULL)) AND
    ("status" = 'processing') = ("leaseUntil" IS NOT NULL)
  ),
  CONSTRAINT "CmsMediaCleanupJob_state_check" CHECK (
    "attempts" >= 0 AND
    (("status" = 'complete') = ("completedAt" IS NOT NULL)) AND
    ("lastError" IS NULL OR "lastError" IN ('provider_unavailable', 'cdn_purge_unavailable', 'invalid_configuration'))
  )
);
CREATE UNIQUE INDEX "CmsMediaCleanupJob_mediaId_key" ON "CmsMediaCleanupJob"("mediaId");
CREATE UNIQUE INDEX "CmsMediaCleanupJob_datasetId_mediaId_key" ON "CmsMediaCleanupJob"("datasetId", "mediaId");
CREATE INDEX "CmsMediaCleanupJob_due_idx" ON "CmsMediaCleanupJob"("status", "nextAttemptAt");
CREATE INDEX "CmsMediaCleanupJob_lease_idx" ON "CmsMediaCleanupJob"("leaseUntil") WHERE "status" = 'processing';
COMMIT;
