-- Add pinned temporary domain fields to keep stable slugs across domain changes.
ALTER TABLE "Site"
ADD COLUMN "temporaryDomainSlug" TEXT,
ADD COLUMN "temporaryDomainSuffix" TEXT;
