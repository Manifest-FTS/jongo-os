-- Git sources like Coolify: a client can have several GitHub Apps, each added
-- as a draft (name, optional organization) before it is registered on GitHub,
-- or filled in manually. Additive / relaxing only.
DROP INDEX IF EXISTS "GithubAppConfig_organizationId_key";
CREATE INDEX "GithubAppConfig_organizationId_idx" ON "GithubAppConfig"("organizationId");
ALTER TABLE "GithubAppConfig" ALTER COLUMN "appId" DROP NOT NULL;
ALTER TABLE "GithubAppConfig" ALTER COLUMN "slug" DROP NOT NULL;
ALTER TABLE "GithubAppConfig" ALTER COLUMN "htmlUrl" DROP NOT NULL;
ALTER TABLE "GithubAppConfig" ALTER COLUMN "clientId" DROP NOT NULL;
ALTER TABLE "GithubAppConfig" ALTER COLUMN "clientSecretEnc" DROP NOT NULL;
ALTER TABLE "GithubAppConfig" ALTER COLUMN "webhookSecretEnc" DROP NOT NULL;
ALTER TABLE "GithubAppConfig" ALTER COLUMN "privateKeyEnc" DROP NOT NULL;
ALTER TABLE "GithubAppConfig" ADD COLUMN "ownerLogin" TEXT;
ALTER TABLE "GithubAppConfig" ADD COLUMN "manual" BOOLEAN NOT NULL DEFAULT false;
