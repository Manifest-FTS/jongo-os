-- Create enum types that were defined in schema but never created in the database
-- (Collaborator.role and SiteCollaborator.role columns were TEXT; Prisma expects PG enum types)

DO $$ BEGIN
  CREATE TYPE "CollaboratorRole" AS ENUM ('admin', 'collaborator');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "SiteCollaboratorRole" AS ENUM ('admin', 'collaborator');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Alter Collaborator.role from TEXT to CollaboratorRole enum (skip if already enum type)
DO $$ BEGIN
  IF (SELECT data_type FROM information_schema.columns WHERE table_name = 'Collaborator' AND column_name = 'role') = 'text' THEN
    ALTER TABLE "Collaborator"
      ALTER COLUMN "role" TYPE "CollaboratorRole"
      USING "role"::"CollaboratorRole";
  END IF;
END $$;

-- Alter SiteCollaborator.role from TEXT to SiteCollaboratorRole enum (skip if already enum type)
DO $$ BEGIN
  IF (SELECT data_type FROM information_schema.columns WHERE table_name = 'SiteCollaborator' AND column_name = 'role') = 'text' THEN
    ALTER TABLE "SiteCollaborator"
      ALTER COLUMN "role" TYPE "SiteCollaboratorRole"
      USING "role"::"SiteCollaboratorRole";
  END IF;
END $$;

-- Set default values to match schema defaults (idempotent)
ALTER TABLE "Collaborator" ALTER COLUMN "role" SET DEFAULT 'collaborator'::"CollaboratorRole";
ALTER TABLE "SiteCollaborator" ALTER COLUMN "role" SET DEFAULT 'collaborator'::"SiteCollaboratorRole";
