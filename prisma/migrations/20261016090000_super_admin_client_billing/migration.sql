-- Atomic rollout; fail rather than block production traffic behind table locks.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

-- Additive global authority, distinct from tenant membership and PlatformAdmin.
CREATE TYPE "GlobalRole" AS ENUM ('super_admin', 'admin', 'collaborator');
CREATE TYPE "ClientBillingMode" AS ENUM ('manual_override', 'bonsai', 'native_stripe', 'exempt');
CREATE TYPE "ClientBillingStatus" AS ENUM ('active_paid', 'past_due', 'pending_setup', 'comped');

ALTER TABLE "User" ADD COLUMN "role" "GlobalRole" NOT NULL DEFAULT 'collaborator';

-- Existing PlatformAdmin grants remain the revocable source of technical
-- authority. Do not duplicate grants into permanent global admin roles.

-- Explicit, case-insensitive promotion. Do not create a passwordless identity.
UPDATE "User" SET "role" = 'super_admin', "updatedAt" = CURRENT_TIMESTAMP
WHERE lower(trim("email")) = 'devkev@manifestfts.com' AND "deletedAt" IS NULL;

ALTER TABLE "Organization"
  ADD COLUMN "billingMode" "ClientBillingMode" NOT NULL DEFAULT 'manual_override',
  ADD COLUMN "billingStatus" "ClientBillingStatus" NOT NULL DEFAULT 'pending_setup',
  ADD COLUMN "billingNotes" TEXT,
  ADD COLUMN "bonsaiClientId" TEXT,
  ADD COLUMN "externalInvoiceUrl" TEXT;

ALTER TABLE "Domain"
  ALTER COLUMN "organizationId" DROP NOT NULL,
  ADD COLUMN "autoRenew" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "isBillable" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "billingOverride" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "registrarSyncedAt" TIMESTAMP(3),
  ADD COLUMN "dnsManagementEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Preserve established order/DNS workflows without enrolling inventory imports.
UPDATE "Domain" SET "dnsManagementEnabled" = true
WHERE "cloudflareZoneId" IS NOT NULL OR "id" IN (
  SELECT "domainId" FROM "DomainCharge" WHERE "operation" IN ('register', 'transfer')
);

-- Registrar inventory must survive client deletion for safe reassignment.
ALTER TABLE "Domain" DROP CONSTRAINT "Domain_organizationId_fkey";
ALTER TABLE "Domain" ADD CONSTRAINT "Domain_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;