-- Generalize the backup catalog beyond WordPress: record what kind of resource
-- was backed up and how many volumes/databases it contained. All nullable/additive.
ALTER TABLE "SiteBackup"
ADD COLUMN "resourceType" TEXT,
ADD COLUMN "volumeCount" INTEGER,
ADD COLUMN "databaseCount" INTEGER;
