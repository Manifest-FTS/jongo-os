import { describe, expect, it } from "vitest";
import type { CoolifyOverview } from "@/lib/coolify";
import { buildAvailableCoolifyAppOptions, normalizeGitRepositoryUrl, parseCoolifyResourceReference } from "./coolify-app-picker";

describe("parseCoolifyResourceReference", () => {
  const url = "https://devops.example.com/project/2el91aa4dm29vsvvcxdl15tc/environment/khmmq96i6odsy886ucc7uhqz/application/uanxn0z1w8wxdlkoryb8dxed/advanced";

  it("picks the resource id out of a pasted Coolify page address", () => {
    expect(parseCoolifyResourceReference(url)).toEqual({
      id: "uanxn0z1w8wxdlkoryb8dxed",
      projectId: "2el91aa4dm29vsvvcxdl15tc",
      environmentId: "khmmq96i6odsy886ucc7uhqz"
    });
  });

  it("understands services and databases, with or without a scheme or trailing path", () => {
    expect(parseCoolifyResourceReference("devops.example.com/project/p1/environment/e1/service/svc123").id).toBe("svc123");
    expect(parseCoolifyResourceReference("https://devops.example.com/project/p1/environment/e1/database/db456/").id).toBe("db456");
  });

  it("never alters a bare id, and leaves an address without a resource unchanged", () => {
    expect(parseCoolifyResourceReference("  uanxn0z1w8wxdlkoryb8dxed ")).toEqual({ id: "uanxn0z1w8wxdlkoryb8dxed" });
    expect(parseCoolifyResourceReference("https://devops.example.com/project/p1/environment/e1").id).toBe("https://devops.example.com/project/p1/environment/e1");
    expect(parseCoolifyResourceReference("").id).toBe("");
  });
});

describe("normalizeGitRepositoryUrl", () => {
  it("turns Coolify's stored forms into a plain https URL", () => {
    expect(normalizeGitRepositoryUrl("Manifest-FTS/dd-thegolflab")).toBe("https://github.com/Manifest-FTS/dd-thegolflab");
    expect(normalizeGitRepositoryUrl("git@github.com:Manifest-FTS/dd-thegolflab.git")).toBe("https://github.com/Manifest-FTS/dd-thegolflab");
    expect(normalizeGitRepositoryUrl("https://github.com/Manifest-FTS/dd-thegolflab.git")).toBe("https://github.com/Manifest-FTS/dd-thegolflab");
  });

  it("never keeps credentials, query strings or fragments", () => {
    expect(normalizeGitRepositoryUrl("https://user:ghp_secret@github.com/org/repo.git?x=1#y")).toBe("https://github.com/org/repo");
  });

  it("returns nothing for empty or unrecognisable values", () => {
    for (const bad of [undefined, null, "", "   ", "not a repo", "ftp://example.com/x"]) expect(normalizeGitRepositoryUrl(bad as string | null | undefined)).toBeUndefined();
  });
});

describe("picker options carry the repository", () => {
  const overview = {
    mode: "live",
    generatedAt: "2026-11-06T00:00:00.000Z",
    projects: [],
    environments: [],
    deployments: [],
    stats: { healthySites: 0, degradedSites: 0, errorSites: 0, unknownSites: 0 },
    sites: [
      { id: "a", name: "Golf Lab", deployTargetId: "a", status: "healthy", productionStatus: "healthy", stagingStatus: "unknown", siteType: "generic", coolifyProjectId: "p1", coolifyProjectName: "Derek Domaleski", gitRepository: "Manifest-FTS/dd-thegolflab" },
      { id: "b", name: "No Repo", deployTargetId: "b", status: "healthy", productionStatus: "healthy", stagingStatus: "unknown", siteType: "generic", coolifyProjectId: "p1", coolifyProjectName: "Derek Domaleski" }
    ]
  } as CoolifyOverview;

  it("adds an https repository URL only when Coolify reports one", () => {
    const options = buildAvailableCoolifyAppOptions(overview, ["p1"], []);
    expect(options.find((option) => option.id === "a")?.gitRepositoryUrl).toBe("https://github.com/Manifest-FTS/dd-thegolflab");
    expect(options.find((option) => option.id === "b")).not.toHaveProperty("gitRepositoryUrl");
  });
});
