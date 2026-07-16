import { describe, expect, it } from "vitest";
import type { CoolifyOverview } from "@/lib/coolify";
import { buildAvailableCoolifyAppOptions } from "./coolify-app-picker";

const overview: CoolifyOverview = {
  mode: "live",
  generatedAt: "2026-07-15T00:00:00.000Z",
  projects: [],
  environments: [],
  deployments: [],
  stats: { healthySites: 0, degradedSites: 0, errorSites: 0, unknownSites: 0 },
  sites: [
    {
      id: "site-1",
      name: "Alpha",
      deployTargetId: "deploy-1",
      status: "healthy",
      productionStatus: "healthy",
      stagingStatus: "healthy",
      siteType: "generic",
      coolifyProjectId: "project-1",
      coolifyProjectName: "Garden State Equality",
      resourceType: "application"
    },
    {
      id: "site-2",
      name: "Beta",
      deployTargetId: "deploy-2",
      status: "healthy",
      productionStatus: "healthy",
      stagingStatus: "healthy",
      siteType: "generic",
      coolifyProjectId: "project-1",
      coolifyProjectName: "Garden State Equality",
      resourceType: "application"
    },
    {
      id: "site-3",
      name: "Gamma",
      deployTargetId: "deploy-3",
      status: "healthy",
      productionStatus: "healthy",
      stagingStatus: "healthy",
      siteType: "generic",
      coolifyProjectId: "project-2",
      coolifyProjectName: "Other Project",
      resourceType: "application"
    }
  ]
};

describe("buildAvailableCoolifyAppOptions", () => {
  it("returns only unimported apps from linked projects", () => {
    const result = buildAvailableCoolifyAppOptions(
      overview,
      ["project-1"],
      [{ coolifyServiceUuid: "site-1", deployTargetId: "deploy-1", name: "Alpha" }]
    );

    expect(result).toEqual([
      {
        id: "site-2",
        name: "Beta",
        projectId: "project-1",
        projectName: "Garden State Equality",
        status: "healthy",
        resourceType: "application"
      }
    ]);
  });
});