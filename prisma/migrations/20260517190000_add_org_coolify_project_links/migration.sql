CREATE TABLE IF NOT EXISTS "OrganizationCoolifyProjectLink" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "organizationId" uuid NOT NULL,
  "coolifyProjectId" text NOT NULL,
  "coolifyProjectName" text,
  "isPrimary" boolean NOT NULL DEFAULT false,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrganizationCoolifyProjectLink_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrganizationCoolifyProjectLink_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "OrganizationCoolifyProjectLink_organizationId_coolifyProjectId_key"
  ON "OrganizationCoolifyProjectLink"("organizationId", "coolifyProjectId");

CREATE INDEX IF NOT EXISTS "OrganizationCoolifyProjectLink_organizationId_idx"
  ON "OrganizationCoolifyProjectLink"("organizationId");

CREATE INDEX IF NOT EXISTS "OrganizationCoolifyProjectLink_coolifyProjectId_idx"
  ON "OrganizationCoolifyProjectLink"("coolifyProjectId");

CREATE INDEX IF NOT EXISTS "OrganizationCoolifyProjectLink_coolifyProjectName_idx"
  ON "OrganizationCoolifyProjectLink"("coolifyProjectName");
