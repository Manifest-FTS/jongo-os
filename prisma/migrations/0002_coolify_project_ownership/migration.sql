-- Add Coolify ownership mapping fields on organizations
ALTER TABLE "Organization"
  ADD COLUMN "coolifyProjectId" TEXT,
  ADD COLUMN "coolifyProjectName" TEXT;

CREATE UNIQUE INDEX "Organization_coolifyProjectId_key" ON "Organization"("coolifyProjectId");
CREATE INDEX "Organization_coolifyProjectName_idx" ON "Organization"("coolifyProjectName");

-- Add Coolify project id + staging toggle on sites
ALTER TABLE "Site"
  ADD COLUMN "coolifyProjectId" TEXT,
  ADD COLUMN "stagingEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Site_coolifyProjectId_idx" ON "Site"("coolifyProjectId");
