import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  organizationFindFirst: vi.fn(),
  queryRaw: vi.fn(),
  siteFindMany: vi.fn(),
  siteCreate: vi.fn()
}));

vi.mock("@/lib/db", () => ({
  db: {
    organization: {
      findFirst: dbMocks.organizationFindFirst
    },
    $queryRaw: dbMocks.queryRaw,
    site: {
      findMany: dbMocks.siteFindMany,
      create: dbMocks.siteCreate
    }
  }
}));

vi.mock("@/lib/coolify", () => ({
  getCoolifyOverview: vi.fn(),
  ensureCoolifyAppBackupSchedules: vi.fn().mockResolvedValue({
    configuredAfter: true,
    note: "already_configured"
  })
}));

import { getCoolifyOverview } from "@/lib/coolify";
import { importLinkedCoolifyProjectSites } from "./coolify-project-import";

describe("importLinkedCoolifyProjectSites", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates missing site records for linked Coolify apps", async () => {
    dbMocks.organizationFindFirst.mockResolvedValue({
      id: "org-1",
      coolifyProjectId: "project-1",
      coolifyProjectName: "Garden State Equality"
    });
    dbMocks.queryRaw.mockResolvedValue([{ coolifyProjectId: "project-1", coolifyProjectName: "Garden State Equality" }]);
    dbMocks.siteFindMany.mockResolvedValue([
      {
        name: "Existing App",
        slug: "existing-app",
        coolifyServiceId: "existing-service",
        coolifyServiceUuid: "existing-uuid",
        coolifyProjectId: "project-1"
      }
    ]);
    dbMocks.siteCreate.mockResolvedValue({ id: "created-site" });
    vi.mocked(getCoolifyOverview).mockResolvedValue({
      mode: "live",
      generatedAt: "2026-07-15T00:00:00.000Z",
      projects: [],
      environments: [],
      deployments: [],
      stats: { healthySites: 0, degradedSites: 0, errorSites: 0, unknownSites: 0 },
      sites: [
        {
          id: "coolify-site-1",
          name: "Existing App",
          deployTargetId: "deploy-existing",
          status: "healthy",
          productionStatus: "healthy",
          stagingStatus: "healthy",
          siteType: "generic",
          coolifyProjectId: "project-1",
          coolifyProjectName: "Garden State Equality",
          coolifyEnvironmentId: "env-1",
          coolifyEnvironmentName: "production",
          resourceType: "application"
        },
        {
          id: "coolify-site-2",
          name: "New App",
          deployTargetId: "deploy-new",
          status: "healthy",
          productionStatus: "healthy",
          stagingStatus: "healthy",
          siteType: "generic",
          coolifyProjectId: "project-1",
          coolifyProjectName: "Garden State Equality",
          coolifyEnvironmentId: "env-2",
          coolifyEnvironmentName: "production",
          resourceType: "application"
        }
      ]
    });

    const result = await importLinkedCoolifyProjectSites("org-1");

    expect(result).toEqual({
      linkedProjectCount: 1,
      matchedCoolifySites: 2,
      createdSites: 1,
      skippedSites: 1,
      backupReconciledSites: 1,
      backupsAlreadyConfigured: 1,
      backupsAutoProvisioned: 0,
      backupsProvisionFailures: 0
    });
    expect(dbMocks.siteCreate).toHaveBeenCalledTimes(1);
    expect(dbMocks.siteCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org-1",
          name: "New App",
          coolifyServiceUuid: "coolify-site-2",
          coolifyServiceId: "deploy-new",
          coolifyProjectId: "project-1"
        })
      })
    );
  });
});