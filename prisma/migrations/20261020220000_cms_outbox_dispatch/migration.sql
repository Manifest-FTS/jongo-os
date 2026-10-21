-- Additive outbox dispatch storage. Depends on pending 20261020180000/20261020200000; edits neither.
-- Targets are operator-configured; secretEnv is an environment variable NAME, never a secret.

CREATE TYPE "CmsContentDeliveryStatus" AS ENUM ('pending', 'delivered', 'dead');

ALTER TABLE "CmsContentOutbox"
    ADD COLUMN "leaseUntil" TIMESTAMP(3),
    ADD COLUMN "leaseToken" UUID,
    ADD COLUMN "lastAttemptAt" TIMESTAMP(3);
ALTER TABLE "CmsContentOutbox" ADD CONSTRAINT "CmsContentOutbox_lease_check" CHECK (
    ("leaseUntil" IS NULL) = ("leaseToken" IS NULL) AND ("leaseUntil" IS NULL OR "status" = 'processing'));
CREATE UNIQUE INDEX "CmsContentOutbox_datasetId_id_key" ON "CmsContentOutbox"("datasetId", "id");

CREATE TABLE "CmsDeliveryTarget" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "datasetId" UUID NOT NULL,
    "consumerId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secretEnv" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CmsDeliveryTarget_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CmsDeliveryTarget_consumer_check" CHECK ("consumerId" ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
    CONSTRAINT "CmsDeliveryTarget_secret_env_check" CHECK ("secretEnv" ~ '^CMS_DELIVERY_SECRET_[A-Z0-9_]{1,64}$'),
    -- HTTPS only; plain HTTP solely for explicit loopback (the dispatcher additionally requires NODE_ENV=test).
    CONSTRAINT "CmsDeliveryTarget_url_check" CHECK (length("url") <= 2048 AND (
        "url" ~ '^https://[^/?#@[:space:]]+/[^?#@[:space:]]*$' OR
        "url" ~ '^http://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]{1,5})?/[^?#@[:space:]]*$'))
);

CREATE TABLE "CmsContentDelivery" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "datasetId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "targetId" UUID NOT NULL,
    "status" "CmsContentDeliveryStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastStatusCode" INTEGER,
    "lastError" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CmsContentDelivery_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CmsContentDelivery_attempts_check" CHECK ("attempts" >= 0),
    -- Fixed codes only: no response bodies, URLs or secrets are persisted.
    CONSTRAINT "CmsContentDelivery_result_check" CHECK (
        ("lastStatusCode" IS NULL OR "lastStatusCode" BETWEEN 100 AND 599) AND
        ("lastError" IS NULL OR "lastError" IN ('http_status', 'redirect', 'timeout', 'network', 'secret_unavailable', 'target_refused'))),
    CONSTRAINT "CmsContentDelivery_delivery_check" CHECK (("status" = 'delivered') = ("deliveredAt" IS NOT NULL))
);

CREATE UNIQUE INDEX "CmsDeliveryTarget_datasetId_consumerId_key" ON "CmsDeliveryTarget"("datasetId", "consumerId");
CREATE UNIQUE INDEX "CmsDeliveryTarget_datasetId_id_key" ON "CmsDeliveryTarget"("datasetId", "id");
CREATE INDEX "CmsDeliveryTarget_datasetId_enabled_idx" ON "CmsDeliveryTarget"("datasetId", "enabled");
CREATE UNIQUE INDEX "CmsContentDelivery_eventId_targetId_key" ON "CmsContentDelivery"("eventId", "targetId");
CREATE INDEX "CmsContentDelivery_datasetId_eventId_idx" ON "CmsContentDelivery"("datasetId", "eventId");
CREATE INDEX "CmsContentDelivery_datasetId_targetId_idx" ON "CmsContentDelivery"("datasetId", "targetId");

ALTER TABLE "CmsDeliveryTarget" ADD CONSTRAINT "CmsDeliveryTarget_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "CmsDataset"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "CmsContentDelivery" ADD CONSTRAINT "CmsContentDelivery_datasetId_eventId_fkey" FOREIGN KEY ("datasetId", "eventId") REFERENCES "CmsContentOutbox"("datasetId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "CmsContentDelivery" ADD CONSTRAINT "CmsContentDelivery_datasetId_targetId_fkey" FOREIGN KEY ("datasetId", "targetId") REFERENCES "CmsDeliveryTarget"("datasetId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
