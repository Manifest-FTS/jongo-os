-- Flywheel-style backup catalog: one row per site backup, each mapping to a
-- restic snapshot in Backblaze B2 holding WordPress files + a database dump.
CREATE TABLE "SiteBackup" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "siteId" UUID NOT NULL,
    "resourceUuid" TEXT NOT NULL,
    "label" TEXT,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "resticSnapshotId" TEXT,
    "sizeBytes" BIGINT,
    "posts" INTEGER,
    "pages" INTEGER,
    "plugins" INTEGER,
    "comments" INTEGER,
    "wpVersion" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "SiteBackup_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SiteBackup_siteId_startedAt_idx" ON "SiteBackup"("siteId", "startedAt");
CREATE INDEX "SiteBackup_resourceUuid_idx" ON "SiteBackup"("resourceUuid");

ALTER TABLE "SiteBackup" ADD CONSTRAINT "SiteBackup_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
