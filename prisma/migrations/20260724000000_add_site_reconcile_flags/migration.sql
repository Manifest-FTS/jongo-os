-- Reconciler-maintained flags. Additive and nullable/defaulted, so existing rows
-- are unaffected until the hourly reconciler populates them.
ALTER TABLE "Site"
ADD COLUMN "isStagingResource" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "resourceMissingSince" TIMESTAMP(3);
