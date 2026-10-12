import { describe, expect, it } from "vitest";
import { planInstallEvent, type SiteRef } from "./github-install-events";

const sites: SiteRef[] = [
  { siteId: "s1", gitRepoId: 500, gitStatus: "linked" },
  { siteId: "s2", gitRepoId: 501, gitStatus: "repo_access_lost" }
];

describe("planInstallEvent", () => {
  it("removes the install and flags every site on uninstall", () => {
    expect(planInstallEvent("installation", { action: "deleted" }, sites)).toEqual({
      installStatus: "removed",
      removeSource: true,
      siteUpdates: [{ siteId: "s1", gitStatus: "install_removed" }, { siteId: "s2", gitStatus: "install_removed" }]
    });
  });
  it("suspends and unsuspends", () => {
    expect(planInstallEvent("installation", { action: "suspend" }, sites).installStatus).toBe("suspended");
    expect(planInstallEvent("installation", { action: "suspend" }, sites).siteUpdates[0]).toEqual({ siteId: "s1", gitStatus: "install_suspended" });
    const back = planInstallEvent("installation", { action: "unsuspend" }, [{ siteId: "s1", gitRepoId: 500, gitStatus: "install_suspended" }]);
    expect(back).toEqual({ installStatus: "active", siteUpdates: [{ siteId: "s1", gitStatus: "linked" }] });
  });
  it("flags sites on repos removed from the install, and restores them when re-added", () => {
    expect(planInstallEvent("installation_repositories", { action: "removed", repositories_removed: [{ id: 500 }] }, sites).siteUpdates).toEqual([
      { siteId: "s1", gitStatus: "repo_access_lost" }
    ]);
    expect(planInstallEvent("installation_repositories", { action: "added", repositories_added: [{ id: 501 }] }, sites).siteUpdates).toEqual([
      { siteId: "s2", gitStatus: "linked" }
    ]);
  });
  it("follows a rename by repo id", () => {
    expect(planInstallEvent("repository", { action: "renamed", repository: { id: 500, full_name: "acme/new-name" } }, sites).siteUpdates).toEqual([
      { siteId: "s1", gitRepoFullName: "acme/new-name" }
    ]);
  });
  it("flags a deleted repo", () => {
    expect(planInstallEvent("repository", { action: "deleted", repository: { id: 500, full_name: "acme/x" } }, sites).siteUpdates).toEqual([
      { siteId: "s1", gitStatus: "repo_access_lost" }
    ]);
  });
  it("does nothing for unrelated events", () => {
    expect(planInstallEvent("star", { action: "created" }, sites)).toEqual({ siteUpdates: [] });
  });
});
