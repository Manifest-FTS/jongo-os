-- Per-site scheduled backups. backupScheduleEnabled is nullable: NULL means
-- "follow the platform default", so enabling globally needs no per-site write.
ALTER TABLE "Site"
ADD COLUMN "backupScheduleEnabled" BOOLEAN,
ADD COLUMN "backupFrequencyHours" INTEGER NOT NULL DEFAULT 24,
ADD COLUMN "lastScheduledBackupAt" TIMESTAMP(3);
