-- Additive storage only. Requires the existing pending CMS foundation migration.
-- No backfill, seeds, publication, credentials, worker or configured-DB execution.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

CREATE TYPE "CmsMarketingPublicationStatus" AS ENUM ('active', 'revoked');
CREATE TYPE "CmsContentOutboxEventType" AS ENUM ('release_publish', 'release_unpublish');
CREATE TYPE "CmsContentOutboxStatus" AS ENUM ('pending', 'processing', 'delivered', 'failed');

CREATE TABLE "CmsMarketingRelease" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "datasetId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "snapshotText" TEXT NOT NULL,
    "payloadChecksum" TEXT NOT NULL,
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CmsMarketingRelease_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CmsMarketingRelease_version_check" CHECK ("sequence" > 0 AND "version" = 1),
    CONSTRAINT "CmsMarketingRelease_checksum_check" CHECK ("payloadChecksum" ~ '^[0-9a-f]{64}$'),
    -- COALESCE is essential: a missing key must fail, not pass via SQL NULL.
    CONSTRAINT "CmsMarketingRelease_payload_check" CHECK (COALESCE(
        jsonb_typeof("payload") = 'object'
        AND "payload" ? 'documents'
        AND ("payload" - 'documents') = '{}'::jsonb
        AND jsonb_typeof("payload" -> 'documents') = 'array'
        AND jsonb_array_length("payload" -> 'documents') <= 100
        AND octet_length("snapshotText") <= 1048576
        AND "payload" -> 'documents' = "snapshotText"::jsonb
        AND octet_length("payload"::text) <= 1048576, false))
);

CREATE TABLE "CmsMarketingPublication" (
    "datasetId" UUID NOT NULL,
    "releaseId" UUID,
    "status" "CmsMarketingPublicationStatus" NOT NULL DEFAULT 'revoked',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CmsMarketingPublication_pkey" PRIMARY KEY ("datasetId"),
    CONSTRAINT "CmsMarketingPublication_revision_check" CHECK ("revision" >= 0),
    CONSTRAINT "CmsMarketingPublication_pointer_check" CHECK (
        ("status" = 'active' AND "releaseId" IS NOT NULL AND "revision" > 0) OR
        ("status" = 'revoked' AND "releaseId" IS NULL))
);

CREATE TABLE "CmsDeliveryCredential" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "datasetId" UUID NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'marketing.read',
    "tokenHash" TEXT NOT NULL,
    "prefix" VARCHAR(16) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CmsDeliveryCredential_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CmsDeliveryCredential_scope_check" CHECK ("type" = 'marketing.read'),
    CONSTRAINT "CmsDeliveryCredential_hash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "CmsDeliveryCredential_prefix_check" CHECK (length(btrim("prefix")) BETWEEN 1 AND 16),
    CONSTRAINT "CmsDeliveryCredential_expiry_check" CHECK ("expiresAt" IS NULL OR "expiresAt" > "createdAt"),
    CONSTRAINT "CmsDeliveryCredential_revocation_check" CHECK ("revokedAt" IS NULL OR "revokedAt" >= "createdAt")
);

CREATE TABLE "CmsContentOutbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "datasetId" UUID NOT NULL,
    "releaseId" UUID NOT NULL,
    "publicationRevision" INTEGER NOT NULL,
    "eventType" "CmsContentOutboxEventType" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "CmsContentOutboxStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CmsContentOutbox_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CmsContentOutbox_revision_check" CHECK ("publicationRevision" > 0 AND "attempts" >= 0),
    CONSTRAINT "CmsContentOutbox_payload_check" CHECK (jsonb_typeof("payload") = 'object' AND octet_length("payload"::text) <= 1048576),
    CONSTRAINT "CmsContentOutbox_delivery_check" CHECK (
        ("status" = 'delivered' AND "deliveredAt" IS NOT NULL) OR
        ("status" <> 'delivered' AND "deliveredAt" IS NULL))
);

CREATE UNIQUE INDEX "CmsMarketingRelease_datasetId_id_key" ON "CmsMarketingRelease"("datasetId", "id");
CREATE UNIQUE INDEX "CmsMarketingRelease_datasetId_sequence_key" ON "CmsMarketingRelease"("datasetId", "sequence");
CREATE INDEX "CmsMarketingRelease_actorId_idx" ON "CmsMarketingRelease"("actorId");
CREATE INDEX "CmsMarketingPublication_datasetId_releaseId_idx" ON "CmsMarketingPublication"("datasetId", "releaseId");
CREATE INDEX "CmsMarketingPublication_actorId_idx" ON "CmsMarketingPublication"("actorId");
CREATE UNIQUE INDEX "CmsDeliveryCredential_tokenHash_key" ON "CmsDeliveryCredential"("tokenHash");
CREATE INDEX "CmsDeliveryCredential_datasetId_revokedAt_idx" ON "CmsDeliveryCredential"("datasetId", "revokedAt");
CREATE INDEX "CmsDeliveryCredential_actorId_idx" ON "CmsDeliveryCredential"("actorId");
CREATE UNIQUE INDEX "CmsContentOutbox_datasetId_publicationRevision_key" ON "CmsContentOutbox"("datasetId", "publicationRevision");
CREATE INDEX "CmsContentOutbox_status_nextAttemptAt_idx" ON "CmsContentOutbox"("status", "nextAttemptAt");
CREATE INDEX "CmsContentOutbox_datasetId_releaseId_idx" ON "CmsContentOutbox"("datasetId", "releaseId");
CREATE INDEX "CmsContentOutbox_actorId_idx" ON "CmsContentOutbox"("actorId");

ALTER TABLE "CmsMarketingRelease" ADD CONSTRAINT "CmsMarketingRelease_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "CmsDataset"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "CmsMarketingRelease" ADD CONSTRAINT "CmsMarketingRelease_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "CmsMarketingPublication" ADD CONSTRAINT "CmsMarketingPublication_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "CmsDataset"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- MATCH SIMPLE permits clearing releaseId while retaining the dataset identity.
ALTER TABLE "CmsMarketingPublication" ADD CONSTRAINT "CmsMarketingPublication_datasetId_releaseId_fkey" FOREIGN KEY ("datasetId", "releaseId") REFERENCES "CmsMarketingRelease"("datasetId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "CmsMarketingPublication" ADD CONSTRAINT "CmsMarketingPublication_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "CmsDeliveryCredential" ADD CONSTRAINT "CmsDeliveryCredential_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "CmsDataset"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "CmsDeliveryCredential" ADD CONSTRAINT "CmsDeliveryCredential_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "CmsContentOutbox" ADD CONSTRAINT "CmsContentOutbox_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "CmsDataset"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "CmsContentOutbox" ADD CONSTRAINT "CmsContentOutbox_datasetId_releaseId_fkey" FOREIGN KEY ("datasetId", "releaseId") REFERENCES "CmsMarketingRelease"("datasetId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "CmsContentOutbox" ADD CONSTRAINT "CmsContentOutbox_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Reuse the pending foundation's append-only guard, without changing it.
CREATE TRIGGER "CmsMarketingRelease_immutable" BEFORE UPDATE OR DELETE ON "CmsMarketingRelease"
FOR EACH ROW EXECUTE FUNCTION "cms_reject_immutable_change"();
CREATE TRIGGER "CmsMarketingRelease_no_truncate" BEFORE TRUNCATE ON "CmsMarketingRelease"
FOR EACH STATEMENT EXECUTE FUNCTION "cms_reject_immutable_change"();

COMMIT;