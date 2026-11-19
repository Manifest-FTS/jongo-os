-- Why scheduled backups are on hold (app stopped, server busy).
ALTER TABLE "Site" ADD COLUMN "backupPausedReason" TEXT;
ALTER TABLE "Site" ADD COLUMN "backupPausedAt" TIMESTAMP(3);
