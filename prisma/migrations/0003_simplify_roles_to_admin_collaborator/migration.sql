-- Simplify roles: migrate operator/viewer → collaborator, preserve admin
-- Collaborator (organization-level team)
UPDATE "Collaborator"
SET role = 'collaborator'
WHERE role IN ('operator', 'viewer');

-- SiteCollaborator (app-level team)
UPDATE "SiteCollaborator"
SET role = 'collaborator'
WHERE role IN ('operator', 'viewer');
