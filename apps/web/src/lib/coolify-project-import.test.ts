import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  organizationFindFirst: vi.fn(),
  organizationFindMany: vi.fn(),
  queryRaw: vi.fn(),
  siteFindMany: vi.fn(),
  siteCreate: vi.fn(),
  siteUpdate: vi.fn(),
  siteBackupFindMany: vi.fn(),
  siteBackupFindFirst: vi.fn(),
  backupRestoreVerificationFindMany: vi.fn()
}));

const routeMocks = vi.hoisted(() => ({
  auth: vi.fn(),
  buildLiveResourceIndex: vi.fn(),
  reconcileSite: vi.fn(),
  archiveMissingSitesDefaultEnabled: vi.fn(),
  decideSiteArchive: vi.fn(),
  shouldAbortArchiveBatch: vi.fn(),
  orderDueBackups: vi.fn(),
  decideStaleRun: vi.fn(),
  orderDueRehearsals: vi.fn(),
  scheduledBackupsDefaultEnabled: vi.fn(),
  notifyBackupEvent: vi.fn(),
  openJobLog: vi.fn(),
  isRateLimitError: vi.fn(),
  isRateLimited: vi.fn(),
  describeCoolifyBackupCapability: vi.fn(),
  hasCoolifyBackupableState: vi.fn(),
  importLinkedCoolifyProjectSites: vi.fn(),
  isSshHostConfigured: vi.fn(),
  refreshPluginInventory: vi.fn(),
  PLUGIN_INVENTORY_REFRESH_AFTER_MINUTES: 60,
  defaultStaleRunHours: 24,
  defaultRehearsalIntervalDays: 7,
  ensureCoolifyAppBackupSchedules: vi.fn().mockResolvedValue({
    configuredAfter: true,
    note: "already_configured"
  })
}));

vi.mock("@/lib/db", () => ({
  db: {
    organization: {
      findFirst: dbMocks.organizationFindFirst,
      findMany: dbMocks.organizationFindMany
    },
    $queryRaw: dbMocks.queryRaw,
    site: {
      findMany: dbMocks.siteFindMany,
      create: dbMocks.siteCreate,
      update: dbMocks.siteUpdate
    },
    siteBackup: {
      findMany: dbMocks.siteBackupFindMany,
      findFirst: dbMocks.siteBackupFindFirst,
      create: vi.fn(),
      update: vi.fn()
    },
    backupRestoreVerification: {
      findMany: dbMocks.backupRestoreVerificationFindMany
    }
  }
}));

vi.mock("@/lib/auth.config", () => ({
  auth: routeMocks.auth
}));

vi.mock("@/lib/coolify", () => ({
  getCoolifyOverview: vi.fn(),
  ensureCoolifyAppBackupSchedules: routeMocks.ensureCoolifyAppBackupSchedules,
  hasCoolifyBackupableState: routeMocks.hasCoolifyBackupableState,
  describeCoolifyBackupCapability: routeMocks.describeCoolifyBackupCapability,
  resolveCoolifyDatabaseUuids: vi.fn().mockResolvedValue([])
}));

vi.mock("@/lib/coolify-project-import", () => ({
  importLinkedCoolifyProjectSites: routeMocks.importLinkedCoolifyProjectSites
}));

vi.mock("@/lib/platform-reconcile", () => ({
  buildLiveResourceIndex: routeMocks.buildLiveResourceIndex,
  reconcileSite: routeMocks.reconcileSite
}));

vi.mock("@/lib/platform-reconcile-match", () => ({
  archiveMissingSitesDefaultEnabled: routeMocks.archiveMissingSitesDefaultEnabled,
  decideSiteArchive: routeMocks.decideSiteArchive,
  shouldAbortArchiveBatch: routeMocks.shouldAbortArchiveBatch,
  orderDueBackups: routeMocks.orderDueBackups
}));

vi.mock("@/lib/coolify-rate-limit", () => ({
  isRateLimitError: routeMocks.isRateLimitError,
  isRateLimited: routeMocks.isRateLimited
}));

vi.mock("@/lib/stale-run", () => ({
  decideStaleRun: routeMocks.decideStaleRun,
  DEFAULT_STALE_RUN_HOURS: routeMocks.defaultStaleRunHours
}));

vi.mock("@/lib/backup-rehearsal", () => ({
  orderDueRehearsals: routeMocks.orderDueRehearsals,
  DEFAULT_REHEARSAL_INTERVAL_DAYS: routeMocks.defaultRehearsalIntervalDays
}));

vi.mock("@/lib/backup-schedule", () => ({
  scheduledBackupsDefaultEnabled: routeMocks.scheduledBackupsDefaultEnabled
}));

vi.mock("@/lib/site-notify", () => ({
  notifyBackupEvent: routeMocks.notifyBackupEvent
}));

vi.mock("@/lib/job-log", () => ({
  openJobLog: routeMocks.openJobLog
}));

vi.mock("@/lib/ssh-exec", () => ({
  isSshHostConfigured: routeMocks.isSshHostConfigured
}));

vi.mock("@/lib/wordpress-plugin-inventory", () => ({
  refreshPluginInventory: routeMocks.refreshPluginInventory,
  PLUGIN_INVENTORY_REFRESH_AFTER_MINUTES: routeMocks.PLUGIN_INVENTORY_REFRESH_AFTER_MINUTES
}));

import { getCoolifyOverview } from "@/lib/coolify";
import { importLinkedCoolifyProjectSites } from "./coolify-project-import";
import { POST as backupReconcilePOST } from "../app/api/ops/backup-reconcile/route";

describe("importLinkedCoolifyProjectSites", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeMocks.auth.mockResolvedValue({ user: { id: "admin-1", email: "admin@example.com" } });
    routeMocks.buildLiveResourceIndex.mockResolvedValue({ complete: true, sites: [] });
    routeMocks.reconcileSite.mockResolvedValue({ mappingRepaired: false, notes: [], isStagingResource: false, resourceMissing: false });
    routeMocks.archiveMissingSitesDefaultEnabled.mockReturnValue(true);
    routeMocks.decideSiteArchive.mockReturnValue({ archive: false });
    routeMocks.shouldAbortArchiveBatch.mockReturnValue({ abort: false });
    routeMocks.orderDueBackups.mockReturnValue([]);
    routeMocks.decideStaleRun.mockReturnValue({ abandon: false, ageHours: 0 });
    routeMocks.orderDueRehearsals.mockReturnValue([]);
    routeMocks.scheduledBackupsDefaultEnabled.mockReturnValue(false);
    routeMocks.isRateLimitError.mockReturnValue(false);
    routeMocks.isRateLimited.mockReturnValue(false);
    routeMocks.isSshHostConfigured.mockReturnValue(false);
    dbMocks.organizationFindMany.mockResolvedValue([]);
    dbMocks.siteFindMany.mockResolvedValue([]);
    dbMocks.siteBackupFindMany.mockResolvedValue([]);
    dbMocks.siteBackupFindFirst.mockResolvedValue(null);
    dbMocks.backupRestoreVerificationFindMany.mockResolvedValue([]);
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
      updatedSites: 0,
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

  it("ignores Coolify apps whose project name matches but project ID does not", async () => {
    dbMocks.organizationFindFirst.mockResolvedValue({
      id: "org-1",
      coolifyProjectId: "project-1",
      coolifyProjectName: "Garden State Equality"
    });
    dbMocks.queryRaw.mockResolvedValue([{ coolifyProjectId: "project-1", coolifyProjectName: "Garden State Equality" }]);
    dbMocks.siteFindMany.mockResolvedValue([]);
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
          name: "Unlinked App",
          deployTargetId: "deploy-unlinked",
          status: "healthy",
          productionStatus: "healthy",
          stagingStatus: "healthy",
          siteType: "generic",
          coolifyProjectId: "project-999",
          coolifyProjectName: "Garden State Equality",
          coolifyEnvironmentId: "env-1",
          coolifyEnvironmentName: "production",
          resourceType: "application"
        }
      ]
    });

    const result = await importLinkedCoolifyProjectSites("org-1");

    expect(result).toEqual({
      linkedProjectCount: 1,
      matchedCoolifySites: 0,
      createdSites: 0,
      updatedSites: 0,
      skippedSites: 0,
      backupReconciledSites: 0,
      backupsAlreadyConfigured: 0,
      backupsAutoProvisioned: 0,
      backupsProvisionFailures: 0
    });
    expect(dbMocks.siteCreate).not.toHaveBeenCalled();
  });

  it("runs the linked Coolify project import during the hourly reconcile pass", async () => {
    process.env.BOOTSTRAP_ADMIN_EMAIL = "admin@example.com";
    dbMocks.organizationFindMany.mockResolvedValue([{ id: "org-1" }, { id: "org-2" }]);
    routeMocks.importLinkedCoolifyProjectSites.mockResolvedValue({
      linkedProjectCount: 1,
      matchedCoolifySites: 1,
      createdSites: 1,
      updatedSites: 0,
      skippedSites: 0,
      backupReconciledSites: 0,
      backupsAlreadyConfigured: 0,
      backupsAutoProvisioned: 0,
      backupsProvisionFailures: 0
    });
    routeMocks.ensureCoolifyAppBackupSchedules.mockResolvedValue({
      configuredAfter: true,
      note: "already_configured"
    });

    const response = await backupReconcilePOST(new Request("http://localhost/api/ops/backup-reconcile"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(routeMocks.importLinkedCoolifyProjectSites).toHaveBeenCalledTimes(2);
    expect(routeMocks.importLinkedCoolifyProjectSites).toHaveBeenCalledWith("org-1");
    expect(routeMocks.importLinkedCoolifyProjectSites).toHaveBeenCalledWith("org-2");
    expect(payload.ok).toBe(true);
  });

  it("refreshes same-UUID metadata from a strictly linked Coolify project", async () => {
    dbMocks.organizationFindFirst.mockResolvedValue({
      id: "org-1",
      coolifyProjectId: "project-1",
      coolifyProjectName: "Current Project"
    });
    dbMocks.queryRaw.mockResolvedValue([]);
    dbMocks.siteFindMany
      .mockResolvedValueOnce([
        {
          id: "site-1",
          name: "Old App Name",
          slug: "stable-slug",
          coolifyServiceId: "coolify-site-1",
          coolifyServiceUuid: "coolify-site-1",
          coolifyProjectId: "project-1",
          coolifyProjectName: "Old Project Name"
        }
      ])
      .mockResolvedValueOnce([{ coolifyServiceUuid: "coolify-site-1" }]);
    vi.mocked(getCoolifyOverview).mockResolvedValue({
      mode: "live",
      generatedAt: "2026-08-19T00:00:00.000Z",
      projects: [],
      environments: [],
      deployments: [],
      stats: { healthySites: 1, degradedSites: 0, errorSites: 0, unknownSites: 0 },
      sites: [
        {
          id: "coolify-site-1",
          name: "Renamed in Coolify",
          deployTargetId: "coolify-site-1",
          status: "healthy",
          productionStatus: "healthy",
          stagingStatus: "unknown",
          siteType: "wordpress",
          coolifyProjectId: "project-1",
          coolifyProjectName: "Current Project",
          coolifyEnvironmentId: "env-1",
          coolifyEnvironmentName: "production",
          resourceType: "service"
        }
      ]
    });

    const result = await importLinkedCoolifyProjectSites("org-1");

    expect(result.updatedSites).toBe(1);
    expect(result.createdSites).toBe(0);
    expect(dbMocks.siteUpdate).toHaveBeenCalledWith({
      where: { id: "site-1" },
      data: {
        name: "Renamed in Coolify",
        coolifyServiceId: "coolify-site-1",
        coolifyServiceUuid: "coolify-site-1",
        coolifyProjectId: "project-1",
        coolifyProjectName: "Current Project"
      },
      select: { id: true }
    });
  });
});