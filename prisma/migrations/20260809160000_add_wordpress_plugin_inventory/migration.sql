-- Cached plugin inventory read directly from the WordPress container.
--
-- The existing REST collector needs a per-site application password, which had
-- been configured for 8 of 51 apps — so the Plugins page rendered an empty table
-- for the rest. This backs the credential-free path (SHORTINIT probe over SSH +
-- docker exec) and is a cache: a page render must not pay for an SSH round trip.
CREATE TABLE IF NOT EXISTS "WordPressPluginInventory" (
  "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
  "siteId"              UUID         NOT NULL,
  "collectedAt"         TIMESTAMP(3) NOT NULL,
  "source"              TEXT         NOT NULL,
  "status"              TEXT         NOT NULL,
  "error"               TEXT,
  "wpVersion"           TEXT,
  -- From WordPress's update_plugins transient. An old value means "Up to date"
  -- is a stale cache rather than a fact, so it is stored and surfaced.
  "updateDataCheckedAt" TIMESTAMP(3),
  "plugins"             JSONB        NOT NULL,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WordPressPluginInventory_pkey" PRIMARY KEY ("id")
);

-- One cached inventory per site; refreshes overwrite in place.
CREATE UNIQUE INDEX IF NOT EXISTS "WordPressPluginInventory_siteId_key"
  ON "WordPressPluginInventory" ("siteId");

-- The background refresh picks the stalest sites first.
CREATE INDEX IF NOT EXISTS "WordPressPluginInventory_collectedAt_idx"
  ON "WordPressPluginInventory" ("collectedAt");

DO $$
BEGIN
  ALTER TABLE "WordPressPluginInventory"
    ADD CONSTRAINT "WordPressPluginInventory_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
