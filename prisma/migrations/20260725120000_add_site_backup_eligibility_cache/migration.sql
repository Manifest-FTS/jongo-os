-- Cache whether a site's Coolify resource has any state worth backing up, so
-- the hourly scheduler can skip stateless apps without an API call per site.
ALTER TABLE "Site" ADD COLUMN IF NOT EXISTS "backupEligible" BOOLEAN;
ALTER TABLE "Site" ADD COLUMN IF NOT EXISTS "backupEligibleAt" TIMESTAMP(3);
