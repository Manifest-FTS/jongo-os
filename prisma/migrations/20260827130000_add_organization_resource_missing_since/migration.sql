-- Automatic Coolify-project <-> Organization sync (lib/organization-reconcile.ts).
-- Additive only.

ALTER TABLE "Organization" ADD COLUMN "resourceMissingSince" TIMESTAMP(3);
