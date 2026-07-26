-- A database resource that belongs inside another app, so the directory can
-- show it within its app instead of beside it.
ALTER TABLE "Site" ADD COLUMN IF NOT EXISTS "parentSiteId" UUID;
CREATE INDEX IF NOT EXISTS "Site_parentSiteId_idx" ON "Site" ("parentSiteId");
