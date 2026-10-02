-- Domains registered through Jongo (Namecheap) with Cloudflare DNS, and one
-- DomainCharge per purchase carrying wholesale, markup and client price.
-- Additive only.

CREATE TABLE "Domain" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending_payment',
    "registrar" TEXT NOT NULL DEFAULT 'namecheap',
    "registrarDomainId" TEXT,
    "transferId" TEXT,
    "cloudflareZoneId" TEXT,
    "nameservers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dnsStatus" TEXT,
    "expiresAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Domain_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Domain_name_key" ON "Domain"("name");
CREATE INDEX "Domain_organizationId_idx" ON "Domain"("organizationId");
CREATE INDEX "Domain_status_idx" ON "Domain"("status");
CREATE INDEX "Domain_expiresAt_idx" ON "Domain"("expiresAt");

ALTER TABLE "Domain" ADD CONSTRAINT "Domain_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "DomainCharge" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "domainId" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "years" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending_payment',
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "wholesaleCents" INTEGER NOT NULL,
    "markupPercent" DOUBLE PRECISION NOT NULL,
    "markupCents" INTEGER NOT NULL,
    "clientCents" INTEGER NOT NULL,
    "registrarChargedCents" INTEGER,
    "stripeCheckoutSessionId" TEXT,
    "stripePaymentIntentId" TEXT,
    "stripeRefundId" TEXT,
    "registrarOrderId" TEXT,
    "registrarTransactionId" TEXT,
    "registrantContact" JSONB,
    "eppCode" TEXT,
    "error" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "fulfilledAt" TIMESTAMP(3),

    CONSTRAINT "DomainCharge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DomainCharge_stripeCheckoutSessionId_key" ON "DomainCharge"("stripeCheckoutSessionId");
CREATE INDEX "DomainCharge_domainId_idx" ON "DomainCharge"("domainId");
CREATE INDEX "DomainCharge_status_idx" ON "DomainCharge"("status");

ALTER TABLE "DomainCharge" ADD CONSTRAINT "DomainCharge_domainId_fkey"
  FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;
