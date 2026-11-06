-- "Sign in with Jongo" Phase 1a: OIDC provider tables + per-app Craft access.
-- Additive only: two enums and four new tables. Nothing existing is dropped, renamed or altered;
-- the only statements touching existing tables are the foreign keys that point from the NEW
-- tables to "Site" and "User" (brief catalog lock, no rewrite, no data change).
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

-- CreateEnum
CREATE TYPE "OidcClientStatus" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "SiteCraftRole" AS ENUM ('reader', 'editor', 'publisher', 'admin');

-- CreateTable
CREATE TABLE "OidcClient" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clientId" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "datasetName" TEXT NOT NULL DEFAULT 'production',
    "status" "OidcClientStatus" NOT NULL DEFAULT 'active',
    "secretHash" TEXT NOT NULL,
    "previousSecretHash" TEXT,
    "previousSecretExpiresAt" TIMESTAMP(3),
    "redirectUris" TEXT[],
    "allowedOrigins" TEXT[],
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "rotatedAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),

    CONSTRAINT "OidcClient_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OidcClient_text_check" CHECK (
        length("clientId") > 0 AND length("name") > 0 AND length("datasetName") > 0 AND length("secretHash") > 0
    ),
    CONSTRAINT "OidcClient_lists_check" CHECK (
        cardinality("redirectUris") <= 20 AND cardinality("allowedOrigins") <= 20
    )
);

-- CreateTable
CREATE TABLE "OidcAuthCode" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "codeHash" TEXT NOT NULL,
    "oidcClientId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "authTime" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OidcAuthCode_pkey" PRIMARY KEY ("id"),
    -- SHA-256 hex of the code; the raw code is never stored.
    CONSTRAINT "OidcAuthCode_hash_check" CHECK ("codeHash" ~ '^[0-9a-f]{64}$'),
    -- PKCE S256 challenge: base64url of 32 bytes is exactly 43 characters.
    CONSTRAINT "OidcAuthCode_challenge_check" CHECK ("codeChallenge" ~ '^[A-Za-z0-9_-]{43}$'),
    -- Codes are short lived (design: 60 s); the cap leaves room for clock skew only.
    CONSTRAINT "OidcAuthCode_ttl_check" CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '5 minutes')
);

-- CreateTable
CREATE TABLE "OidcConsent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "oidcClientId" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "OidcConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteCraftAccess" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "siteId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "SiteCraftRole" NOT NULL,
    "grantedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "SiteCraftAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OidcClient_clientId_key" ON "OidcClient"("clientId");

-- CreateIndex
CREATE INDEX "OidcClient_siteId_organizationId_idx" ON "OidcClient"("siteId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "OidcAuthCode_codeHash_key" ON "OidcAuthCode"("codeHash");

-- CreateIndex
CREATE INDEX "OidcAuthCode_oidcClientId_idx" ON "OidcAuthCode"("oidcClientId");

-- CreateIndex
CREATE INDEX "OidcAuthCode_userId_idx" ON "OidcAuthCode"("userId");

-- CreateIndex
CREATE INDEX "OidcAuthCode_expiresAt_idx" ON "OidcAuthCode"("expiresAt");

-- CreateIndex
CREATE INDEX "OidcConsent_oidcClientId_idx" ON "OidcConsent"("oidcClientId");

-- CreateIndex
CREATE UNIQUE INDEX "OidcConsent_userId_oidcClientId_key" ON "OidcConsent"("userId", "oidcClientId");

-- CreateIndex
CREATE INDEX "SiteCraftAccess_siteId_userId_idx" ON "SiteCraftAccess"("siteId", "userId");

-- CreateIndex
CREATE INDEX "SiteCraftAccess_userId_idx" ON "SiteCraftAccess"("userId");

-- At most one ACTIVE grant per (site, user); revoked rows are history. Not expressible in Prisma.
CREATE UNIQUE INDEX "SiteCraftAccess_active_siteId_userId_key" ON "SiteCraftAccess"("siteId", "userId") WHERE "revokedAt" IS NULL;

-- AddForeignKey
ALTER TABLE "OidcClient" ADD CONSTRAINT "OidcClient_siteId_organizationId_fkey" FOREIGN KEY ("siteId", "organizationId") REFERENCES "Site"("id", "organizationId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OidcClient" ADD CONSTRAINT "OidcClient_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OidcAuthCode" ADD CONSTRAINT "OidcAuthCode_oidcClientId_fkey" FOREIGN KEY ("oidcClientId") REFERENCES "OidcClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OidcAuthCode" ADD CONSTRAINT "OidcAuthCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OidcConsent" ADD CONSTRAINT "OidcConsent_oidcClientId_fkey" FOREIGN KEY ("oidcClientId") REFERENCES "OidcClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OidcConsent" ADD CONSTRAINT "OidcConsent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteCraftAccess" ADD CONSTRAINT "SiteCraftAccess_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteCraftAccess" ADD CONSTRAINT "SiteCraftAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteCraftAccess" ADD CONSTRAINT "SiteCraftAccess_grantedByUserId_fkey" FOREIGN KEY ("grantedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
