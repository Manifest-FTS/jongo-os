import { describe, expect, it } from "vitest";
import { gitSourceSteps, parsePublicRepoUrl } from "./git-sources";

describe("gitSourceSteps", () => {
  it("starts at Register, like Coolify's new GitHub App", () => {
    expect(gitSourceSteps({ appId: null }, null)).toEqual({ status: "draft", register: "todo", install: "blocked" });
  });
  it("moves to Install once registered", () => {
    expect(gitSourceSteps({ appId: 123 }, null)).toEqual({ status: "registered", register: "done", install: "todo" });
  });
  it("is ready when installed and the hosting source exists", () => {
    expect(gitSourceSteps({ appId: 123 }, { status: "active", coolifySourceUuid: "src" })).toEqual({ status: "ready", register: "done", install: "done" });
  });
  it("says when setup is still finishing, suspended or uninstalled", () => {
    expect(gitSourceSteps({ appId: 123 }, { status: "active", coolifySourceUuid: null }).status).toBe("finishing");
    expect(gitSourceSteps({ appId: 123 }, { status: "suspended", coolifySourceUuid: "src" }).status).toBe("suspended");
    expect(gitSourceSteps({ appId: 123 }, { status: "removed", coolifySourceUuid: null })).toEqual({ status: "registered", register: "done", install: "todo" });
  });
});

describe("parsePublicRepoUrl", () => {
  it("accepts GitHub, GitLab and Bitbucket https URLs and normalises them", () => {
    expect(parsePublicRepoUrl("https://github.com/vercel/next.js")).toEqual({ ok: true, url: "https://github.com/vercel/next.js", host: "github.com", fullName: "vercel/next.js" });
    expect(parsePublicRepoUrl(" https://github.com/vercel/next.js.git/ ")).toEqual({ ok: true, url: "https://github.com/vercel/next.js", host: "github.com", fullName: "vercel/next.js" });
    expect(parsePublicRepoUrl("https://gitlab.com/group/sub/project").ok).toBe(true);
    expect(parsePublicRepoUrl("https://github.com/vercel/next.js/tree/canary")).toEqual({ ok: true, url: "https://github.com/vercel/next.js", host: "github.com", fullName: "vercel/next.js" });
  });
  it("refuses anything that isn't a public https repo URL", () => {
    expect(parsePublicRepoUrl("git@github.com:a/b.git").ok).toBe(false);
    expect(parsePublicRepoUrl("http://github.com/a/b").ok).toBe(false);
    expect(parsePublicRepoUrl("https://github.com/onlyowner").ok).toBe(false);
    expect(parsePublicRepoUrl("https://user:token@github.com/a/b").ok).toBe(false);
    expect(parsePublicRepoUrl("https://127.0.0.1/a/b").ok).toBe(false);
  });
});
