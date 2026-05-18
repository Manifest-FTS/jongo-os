ALTER TABLE "OrganizationCoolifyProjectLink"
ADD COLUMN IF NOT EXISTS "deletedAt" timestamp(3);

CREATE INDEX IF NOT EXISTS "OrganizationCoolifyProjectLink_deletedAt_idx"
  ON "OrganizationCoolifyProjectLink" ("deletedAt");
