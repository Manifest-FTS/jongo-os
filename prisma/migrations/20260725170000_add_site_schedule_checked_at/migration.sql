-- Throttle the Coolify backup-schedule sweep: re-checking every app hourly
-- exceeds Coolify's per-token rate limit on its own.
ALTER TABLE "Site" ADD COLUMN IF NOT EXISTS "scheduleCheckedAt" TIMESTAMP(3);
