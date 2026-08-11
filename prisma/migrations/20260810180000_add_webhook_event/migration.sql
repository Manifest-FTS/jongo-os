-- Inbound webhook delivery log.
--
-- deliveryId is UNIQUE and that is the idempotency mechanism: senders retry, and
-- "delete this site" must not be applied twice. Every delivery is recorded with
-- its outcome so a skipped or failed event is visible afterwards rather than
-- being a silent no-op.
CREATE TABLE IF NOT EXISTS "WebhookEvent" (
  "id"            UUID         NOT NULL DEFAULT gen_random_uuid(),
  "source"        TEXT         NOT NULL,
  "deliveryId"    TEXT         NOT NULL,
  "eventType"     TEXT         NOT NULL,
  "outcome"       TEXT         NOT NULL,
  "detail"        TEXT,
  "resourceUuids" TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  "siteIds"       UUID[]       NOT NULL DEFAULT ARRAY[]::UUID[],
  "receivedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WebhookEvent_deliveryId_key" ON "WebhookEvent" ("deliveryId");
CREATE INDEX IF NOT EXISTS "WebhookEvent_source_receivedAt_idx" ON "WebhookEvent" ("source", "receivedAt");
CREATE INDEX IF NOT EXISTS "WebhookEvent_outcome_idx" ON "WebhookEvent" ("outcome");
