import { getDb } from "@/lib/db";
import type { SiteSource } from "@/lib/site-source-copy";

/** The GitHub source of a site, for the Source card and the site banner. Null when not deployed from GitHub. */
export async function loadSiteSource(siteDbId: string): Promise<SiteSource | null> {
  const db: any = await getDb();
  if (!db || !/^[0-9a-f-]{36}$/i.test(siteDbId)) return null;
  const site = await db.site.findUnique({
    where: { id: siteDbId },
    select: {
      organizationId: true,
      gitRepoFullName: true,
      gitBranch: true,
      gitStagingBranch: true,
      autoDeploy: true,
      gitStatus: true,
      pendingCommitSha: true,
      pendingCommitMessage: true,
      lastDeployedSha: true,
      githubInstallation: { select: { accountLogin: true, accountType: true, installationId: true } }
    }
  }).catch(() => null);
  if (!site?.gitRepoFullName || !site.githubInstallation) return null;
  const { installationSettingsUrl } = await import("@/lib/github-installations");
  return {
    organizationId: site.organizationId,
    repo: site.gitRepoFullName,
    branch: site.gitBranch ?? "main",
    stagingBranch: site.gitStagingBranch,
    autoDeploy: site.autoDeploy,
    gitStatus: site.gitStatus,
    pendingCommitSha: site.pendingCommitSha,
    pendingCommitMessage: site.pendingCommitMessage,
    lastDeployedSha: site.lastDeployedSha,
    manageUrl: installationSettingsUrl(site.githubInstallation)
  };
}
