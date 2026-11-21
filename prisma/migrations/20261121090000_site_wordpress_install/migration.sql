-- WordPress first-time setup run by Jongo for sites it creates.
ALTER TABLE "Site" ADD COLUMN IF NOT EXISTS "wpInstallState" TEXT;
ALTER TABLE "Site" ADD COLUMN IF NOT EXISTS "wpInstallError" TEXT;
ALTER TABLE "Site" ADD COLUMN IF NOT EXISTS "wpInstalledAt" TIMESTAMP(3);
ALTER TABLE "Site" ADD COLUMN IF NOT EXISTS "wpInstallStartedAt" TIMESTAMP(3);
ALTER TABLE "Site" ADD COLUMN IF NOT EXISTS "wpInstallConfig" JSONB;
ALTER TABLE "Site" ADD COLUMN IF NOT EXISTS "wpAdminPasswordEnc" TEXT;
