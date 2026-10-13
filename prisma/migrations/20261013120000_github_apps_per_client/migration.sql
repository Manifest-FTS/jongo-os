-- A GitHub App per client (created by the client from Connect GitHub), instead
-- of one shared platform app. Additive: a row with no organizationId is the
-- optional shared app.
ALTER TABLE "GithubAppConfig" ADD COLUMN "organizationId" UUID;
CREATE UNIQUE INDEX "GithubAppConfig_organizationId_key" ON "GithubAppConfig"("organizationId");
CREATE UNIQUE INDEX "GithubAppConfig_appId_key" ON "GithubAppConfig"("appId");
ALTER TABLE "GithubAppConfig" ADD CONSTRAINT "GithubAppConfig_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GithubInstallation" ADD COLUMN "githubAppConfigId" UUID;
ALTER TABLE "GithubInstallation" ADD CONSTRAINT "GithubInstallation_githubAppConfigId_fkey"
  FOREIGN KEY ("githubAppConfigId") REFERENCES "GithubAppConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;
