-- Which Coolify resource is this app's staging copy. Set by Jongo when it
-- creates or re-attaches one; null means "not recorded", and detection falls
-- back to name matching as before. Additive only.

ALTER TABLE "Site" ADD COLUMN "stagingTargetUuid" TEXT;
