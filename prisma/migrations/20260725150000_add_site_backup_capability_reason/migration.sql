-- Cache why an app can or cannot be backed up, so the UI can hide backup
-- features for apps that have nothing to back up without an API call per page.
ALTER TABLE "Site" ADD COLUMN IF NOT EXISTS "backupCapabilityReason" TEXT;
