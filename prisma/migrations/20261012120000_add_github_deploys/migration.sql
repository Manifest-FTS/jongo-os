-- Deploy from the customer's own GitHub (docs/superpowers/specs/2026-10-12-github-deploys-design.md).
-- Additive only.

CREATE TABLE "GithubAppConfig" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "appId" INTEGER NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "htmlUrl" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretEnc" TEXT NOT NULL,
    "webhookSecretEnc" TEXT NOT NULL,
    "privateKeyEnc" TEXT NOT NULL,
    "coolifyPrivateKeyUuid" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GithubAppConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GithubInstallation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "installationId" BIGINT NOT NULL,
    "accountLogin" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "accountId" BIGINT,
    "repositorySelection" TEXT,
    "coolifySourceUuid" TEXT,
    "coolifySourceId" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastError" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "GithubInstallation_pkey" PRIMARY KEY ("id")
);

-- One install belongs to one organization.
CREATE UNIQUE INDEX "GithubInstallation_installationId_key" ON "GithubInstallation"("installationId");
CREATE INDEX "GithubInstallation_organizationId_idx" ON "GithubInstallation"("organizationId");

ALTER TABLE "GithubInstallation" ADD CONSTRAINT "GithubInstallation_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "GithubWebhookDelivery" (
    "deliveryId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GithubWebhookDelivery_pkey" PRIMARY KEY ("deliveryId")
);
CREATE INDEX "GithubWebhookDelivery_receivedAt_idx" ON "GithubWebhookDelivery"("receivedAt");

ALTER TABLE "Site" ADD COLUMN "githubInstallationId" UUID;
ALTER TABLE "Site" ADD COLUMN "gitRepoFullName" TEXT;
ALTER TABLE "Site" ADD COLUMN "gitRepoId" TEXT;
ALTER TABLE "Site" ADD COLUMN "gitBranch" TEXT;
ALTER TABLE "Site" ADD COLUMN "gitStagingBranch" TEXT;
ALTER TABLE "Site" ADD COLUMN "autoDeploy" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Site" ADD COLUMN "gitStatus" TEXT;
ALTER TABLE "Site" ADD COLUMN "pendingCommitSha" TEXT;
ALTER TABLE "Site" ADD COLUMN "pendingCommitMessage" TEXT;
ALTER TABLE "Site" ADD COLUMN "lastDeployedSha" TEXT;

CREATE INDEX "Site_githubInstallationId_gitRepoId_idx" ON "Site"("githubInstallationId", "gitRepoId");

ALTER TABLE "Site" ADD CONSTRAINT "Site_githubInstallationId_fkey"
  FOREIGN KEY ("githubInstallationId") REFERENCES "GithubInstallation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
