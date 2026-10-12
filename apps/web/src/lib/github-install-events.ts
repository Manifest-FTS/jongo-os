/**
 * What an installation / repository webhook means for Jongo: the install's
 * status and which sites change. Pure, so every row of the revocation table in
 * the spec is a test.
 */
export type SiteRef = { siteId: string; gitRepoId: number | null; gitStatus: string | null };
export type InstallStatus = "active" | "suspended" | "removed";
export type SiteUpdate = { siteId: string; gitStatus?: string; gitRepoFullName?: string };
export type InstallEventPlan = { installStatus?: InstallStatus; removeSource?: boolean; siteUpdates: SiteUpdate[] };

function ids(list: unknown): Set<number> {
  return new Set((Array.isArray(list) ? list : []).map((repo: any) => Number(repo?.id)).filter(Number.isFinite));
}

export function planInstallEvent(event: string, payload: any, sites: SiteRef[]): InstallEventPlan {
  const action = String(payload?.action ?? "");

  if (event === "installation") {
    if (action === "deleted") {
      return { installStatus: "removed", removeSource: true, siteUpdates: sites.map((s) => ({ siteId: s.siteId, gitStatus: "install_removed" })) };
    }
    if (action === "suspend") {
      return { installStatus: "suspended", siteUpdates: sites.map((s) => ({ siteId: s.siteId, gitStatus: "install_suspended" })) };
    }
    if (action === "unsuspend") {
      return {
        installStatus: "active",
        siteUpdates: sites.filter((s) => s.gitStatus === "install_suspended").map((s) => ({ siteId: s.siteId, gitStatus: "linked" }))
      };
    }
    return { siteUpdates: [] };
  }

  if (event === "installation_repositories") {
    if (action === "removed") {
      const removed = ids(payload?.repositories_removed);
      return { siteUpdates: sites.filter((s) => s.gitRepoId !== null && removed.has(s.gitRepoId)).map((s) => ({ siteId: s.siteId, gitStatus: "repo_access_lost" })) };
    }
    if (action === "added") {
      const added = ids(payload?.repositories_added);
      return {
        siteUpdates: sites
          .filter((s) => s.gitRepoId !== null && added.has(s.gitRepoId) && s.gitStatus === "repo_access_lost")
          .map((s) => ({ siteId: s.siteId, gitStatus: "linked" }))
      };
    }
    return { siteUpdates: [] };
  }

  if (event === "repository") {
    const repoId = Number(payload?.repository?.id);
    const matching = sites.filter((s) => s.gitRepoId === repoId);
    if (action === "renamed" || action === "transferred") {
      const fullName = String(payload?.repository?.full_name ?? "");
      return { siteUpdates: fullName ? matching.map((s) => ({ siteId: s.siteId, gitRepoFullName: fullName })) : [] };
    }
    if (action === "deleted") {
      return { siteUpdates: matching.map((s) => ({ siteId: s.siteId, gitStatus: "repo_access_lost" })) };
    }
  }

  return { siteUpdates: [] };
}
