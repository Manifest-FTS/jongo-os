-- The production address a site uses everywhere; other hosts are fallbacks.
ALTER TABLE "Site" ADD COLUMN "primaryDomain" TEXT;
ALTER TABLE "Site" ADD COLUMN "primaryDomainDnsStatus" TEXT;
ALTER TABLE "Site" ADD COLUMN "primaryDomainCheckedAt" TIMESTAMP(3);
ALTER TABLE "Site" ADD COLUMN "primaryDomainError" TEXT;
