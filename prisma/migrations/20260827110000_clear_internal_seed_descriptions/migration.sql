-- Collaborators must never see a Coolify reference (repo policy). A one-off
-- sync script wrote "Imported from approved Coolify ownership mapping" into
-- Organization.description / Site.description -- a free-text field shown to
-- every collaborator with access, on the clients list and every app page.
-- The script is fixed (scripts/sync-approved-coolify-mappings.mjs,
-- scripts/approved-sync-insert-only.sql); this clears the value it already
-- wrote, back to null like any other never-set description.

UPDATE "Organization"
SET description = NULL
WHERE description = 'Imported from approved Coolify ownership mapping';

UPDATE "Site"
SET description = NULL
WHERE description = 'Imported from approved Coolify ownership mapping';
