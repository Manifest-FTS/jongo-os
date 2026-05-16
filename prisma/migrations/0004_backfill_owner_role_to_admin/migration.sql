-- Backfill stale legacy role values into the current enum-safe model.
-- Idempotent updates so this is safe to run in any environment.

UPDATE "Collaborator"
SET role = 'admin'
WHERE role = 'owner';

UPDATE "Collaborator"
SET role = 'collaborator'
WHERE role IN ('operator', 'viewer');

UPDATE "SiteCollaborator"
SET role = 'admin'
WHERE role = 'owner';

UPDATE "SiteCollaborator"
SET role = 'collaborator'
WHERE role IN ('operator', 'viewer');
