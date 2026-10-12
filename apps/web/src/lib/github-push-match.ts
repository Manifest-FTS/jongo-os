/**
 * Which sites a GitHub push deploys. Matched on installation + repo id (ids
 * survive renames) + branch. Tags and branch deletions never deploy, and a site
 * whose GitHub access is broken is skipped rather than failing a deploy.
 */
export type PushEvent = {
  ref: string;
  after: string;
  deleted: boolean;
  installationId: number;
  repoId: number;
  headCommit: { message: string; author: string } | null;
};

export type LinkedSite = {
  siteId: string;
  installationId: number;
  gitRepoId: number;
  gitBranch: string | null;
  gitStagingBranch: string | null;
  autoDeploy: boolean;
  gitStatus: string;
  stagingEnabled: boolean;
};

export type PushAction = { siteId: string; target: "production" | "staging"; action: "deploy" | "record_pending" };

export function branchFromRef(ref: string): string | null {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
}

export function sitesForPush(push: PushEvent, sites: LinkedSite[]): PushAction[] {
  const branch = branchFromRef(push.ref);
  if (!branch || push.deleted) return [];
  const actions: PushAction[] = [];
  for (const site of sites) {
    if (site.installationId !== push.installationId || site.gitRepoId !== push.repoId || site.gitStatus !== "linked") continue;
    if (site.gitBranch === branch) {
      actions.push({ siteId: site.siteId, target: "production", action: site.autoDeploy ? "deploy" : "record_pending" });
    } else if (site.gitStagingBranch && site.gitStagingBranch === branch && site.stagingEnabled) {
      actions.push({ siteId: site.siteId, target: "staging", action: site.autoDeploy ? "deploy" : "record_pending" });
    }
  }
  return actions;
}
