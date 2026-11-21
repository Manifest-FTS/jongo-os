-- Read-only team members.
ALTER TYPE "CollaboratorRole" ADD VALUE IF NOT EXISTS 'viewer';
ALTER TYPE "SiteCollaboratorRole" ADD VALUE IF NOT EXISTS 'viewer';
