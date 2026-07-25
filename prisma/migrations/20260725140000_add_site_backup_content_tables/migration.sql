-- Tables actually captured, so an empty-database backup is not reported as a
-- healthy restore point.
ALTER TABLE "SiteBackup" ADD COLUMN IF NOT EXISTS "databaseTables" INTEGER;
