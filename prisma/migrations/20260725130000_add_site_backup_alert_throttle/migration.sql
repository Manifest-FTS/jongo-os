-- Rate-limit state for scheduled-backup failure alerts.
ALTER TABLE "Site" ADD COLUMN IF NOT EXISTS "backupAlertSentAt" TIMESTAMP(3);
