import { describe, expect, it } from "vitest";
import { sitesForPush, type LinkedSite, type PushEvent } from "./github-push-match";

const push = (over: Partial<PushEvent> = {}): PushEvent => ({
  ref: "refs/heads/main",
  after: "abc123",
  deleted: false,
  installationId: 11,
  repoId: 500,
  headCommit: { message: "Fix header", author: "dev" },
  ...over
});
const site = (over: Partial<LinkedSite> = {}): LinkedSite => ({
  siteId: "s1",
  installationId: 11,
  gitRepoId: 500,
  gitBranch: "main",
  gitStagingBranch: null,
  autoDeploy: true,
  gitStatus: "linked",
  stagingEnabled: false,
  ...over
});

describe("sitesForPush", () => {
  it("deploys production for a push to the linked branch", () => {
    expect(sitesForPush(push(), [site()])).toEqual([{ siteId: "s1", target: "production", action: "deploy" }]);
  });
  it("deploys staging for the staging branch only when staging is on", () => {
    const s = site({ gitStagingBranch: "develop", stagingEnabled: true });
    expect(sitesForPush(push({ ref: "refs/heads/develop" }), [s])).toEqual([{ siteId: "s1", target: "staging", action: "deploy" }]);
    expect(sitesForPush(push({ ref: "refs/heads/develop" }), [{ ...s, stagingEnabled: false }])).toEqual([]);
  });
  it("records a pending commit instead of deploying when auto-deploy is off", () => {
    expect(sitesForPush(push(), [site({ autoDeploy: false })])).toEqual([{ siteId: "s1", target: "production", action: "record_pending" }]);
  });
  it("ignores tags and branch deletions", () => {
    expect(sitesForPush(push({ ref: "refs/tags/v1" }), [site()])).toEqual([]);
    expect(sitesForPush(push({ deleted: true }), [site()])).toEqual([]);
  });
  it("ignores other installations, other repos and other branches", () => {
    expect(sitesForPush(push({ installationId: 12 }), [site()])).toEqual([]);
    expect(sitesForPush(push({ repoId: 501 }), [site()])).toEqual([]);
    expect(sitesForPush(push({ ref: "refs/heads/feature" }), [site()])).toEqual([]);
  });
  it("ignores sites whose GitHub access is broken", () => {
    expect(sitesForPush(push(), [site({ gitStatus: "repo_access_lost" })])).toEqual([]);
    expect(sitesForPush(push(), [site({ gitStatus: "install_suspended" })])).toEqual([]);
  });
  it("handles several sites on one repo", () => {
    const result = sitesForPush(push(), [site(), site({ siteId: "s2", autoDeploy: false }), site({ siteId: "s3", gitBranch: "other" })]);
    expect(result).toEqual([
      { siteId: "s1", target: "production", action: "deploy" },
      { siteId: "s2", target: "production", action: "record_pending" }
    ]);
  });
});
