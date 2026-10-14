/** Shared by the Source card (client) and the site overview banner (server). */
export type SiteSource = {
  organizationId: string;
  repo: string;
  branch: string;
  stagingBranch: string | null;
  autoDeploy: boolean;
  gitStatus: string | null;
  pendingCommitSha: string | null;
  pendingCommitMessage: string | null;
  lastDeployedSha: string | null;
  manageUrl: string | null;
  /** The Git source (GitHub App) the app deploys through. */
  sourceId: string | null;
};

export const GIT_STATUS_WARNINGS: Record<string, string> = {
  repo_access_lost: "Jongo can no longer read this repo (it was removed from the GitHub connection, deleted, or made inaccessible). The site keeps running, but pushes don't deploy.",
  install_removed: "GitHub was disconnected from this client. The site keeps running, but pushes don't deploy.",
  install_suspended: "The GitHub connection is suspended on GitHub. The site keeps running, but pushes don't deploy."
};
