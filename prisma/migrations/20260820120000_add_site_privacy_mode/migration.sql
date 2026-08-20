-- Privacy Mode: HTTP Basic Auth in front of a live site.
--
-- Additive only. privacyModePassword holds cleartext deliberately: the product
-- displays the current credentials so an operator can hand them to a client,
-- which a hash cannot support. It gates a not-yet-public site rather than an
-- account, and the API returns it only to a caller who may already manage the
-- site. See lib/privacy-mode.ts.

ALTER TABLE "Site"
  ADD COLUMN "privacyModeEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "privacyModeUsername" TEXT,
  ADD COLUMN "privacyModePassword" TEXT,
  ADD COLUMN "privacyModeUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "privacyModeUpdatedBy" UUID,
  ADD COLUMN "privacyModeProviderState" TEXT,
  ADD COLUMN "privacyModeProviderError" TEXT;
