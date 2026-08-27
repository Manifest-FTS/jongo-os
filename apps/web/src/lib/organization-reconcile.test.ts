import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  organizationFindMany: vi.fn(),
  organizationCreate: vi.fn(),
  organizationUpdate: vi.fn(),
  organizationCoolifyProjectLinkCreate: vi.fn(),
  userFindFirst: vi.fn(),
  organizationFindUnique: vi.fn(),
  siteUpdateMany: vi.fn(),
  transaction: vi.fn()
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn().mockResolvedValue({
    organization: {
      findMany: dbMocks.organizationFindMany,
      create: dbMocks.organizationCreate,
      update: dbMocks.organizationUpdate,
      findUnique: dbMocks.organizationFindUnique
    },
    organizationCoolifyProjectLink: { create: dbMocks.organizationCoolifyProjectLinkCreate },
    user: { findFirst: dbMocks.userFindFirst },
    site: { updateMany: dbMocks.siteUpdateMany },
    $transaction: dbMocks.transaction
  })
}));

const coolifyMocks = vi.hoisted(() => ({ listCoolifyProjects: vi.fn() }));
vi.mock("@/lib/coolify", () => ({ listCoolifyProjects: coolifyMocks.listCoolifyProjects }));

const { autoSyncCoolifyProjectsDefaultEnabled, syncCoolifyProjectsToOrganizations } = await import(
  "./organization-reconcile"
);

describe("autoSyncCoolifyProjectsDefaultEnabled", () => {
  it("defaults on", () => {
    expect(autoSyncCoolifyProjectsDefaultEnabled(undefined)).toBe(true);
  });

  it("is off for explicit false-ish values", () => {
    for (const v of ["false", "0", "off", "no", "FALSE"]) {
      expect(autoSyncCoolifyProjectsDefaultEnabled(v)).toBe(false);
    }
  });
});

describe("syncCoolifyProjectsToOrganizations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BOOTSTRAP_ADMIN_EMAIL = "admin@example.com";
    dbMocks.transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]));
    dbMocks.organizationFindUnique.mockResolvedValue(null);
  });

  it("skips entirely when Coolify cannot be reached", async () => {
    coolifyMocks.listCoolifyProjects.mockRejectedValue(new Error("network error"));
    const result = await syncCoolifyProjectsToOrganizations();
    expect(result).toMatchObject({ ran: false, reason: "coolify_unreachable" });
  });

  it("creates a client for a live project with no linked Organization", async () => {
    coolifyMocks.listCoolifyProjects.mockResolvedValue([{ id: "proj-1", name: "Acme Co" }]);
    dbMocks.organizationFindMany.mockResolvedValue([]);
    dbMocks.userFindFirst.mockResolvedValue({ id: "owner-1" });
    dbMocks.organizationCreate.mockResolvedValue({ id: "org-1" });

    const result = await syncCoolifyProjectsToOrganizations();

    expect(dbMocks.organizationCreate).toHaveBeenCalledTimes(1);
    expect(dbMocks.organizationCoolifyProjectLinkCreate).toHaveBeenCalledTimes(1);
    expect(result.created).toBe(1);
  });

  it("does not create a client when there is no owner to assign it to", async () => {
    coolifyMocks.listCoolifyProjects.mockResolvedValue([{ id: "proj-1", name: "Acme Co" }]);
    dbMocks.organizationFindMany.mockResolvedValue([]);
    dbMocks.userFindFirst.mockResolvedValue(null);

    const result = await syncCoolifyProjectsToOrganizations();

    expect(dbMocks.organizationCreate).not.toHaveBeenCalled();
    expect(result.created).toBe(0);
  });

  it("does not create a client for a project that is already linked", async () => {
    coolifyMocks.listCoolifyProjects.mockResolvedValue([{ id: "proj-1", name: "Acme Co" }]);
    dbMocks.organizationFindMany.mockResolvedValue([{ id: "org-1", coolifyProjectId: "proj-1", resourceMissingSince: null }]);
    dbMocks.userFindFirst.mockResolvedValue({ id: "owner-1" });

    await syncCoolifyProjectsToOrganizations();

    expect(dbMocks.organizationCreate).not.toHaveBeenCalled();
  });

  it("marks a client's project missing on first sight, without deleting it", async () => {
    coolifyMocks.listCoolifyProjects.mockResolvedValue([]);
    dbMocks.organizationFindMany.mockResolvedValue([
      { id: "org-1", coolifyProjectId: "proj-gone", resourceMissingSince: null }
    ]);
    dbMocks.userFindFirst.mockResolvedValue({ id: "owner-1" });

    const result = await syncCoolifyProjectsToOrganizations();

    expect(dbMocks.organizationUpdate).toHaveBeenCalledWith({
      where: { id: "org-1" },
      data: { resourceMissingSince: expect.any(Date) }
    });
    expect(result.missingSinceSet).toBe(1);
    expect(result.archived).toBe(0);
  });

  it("archives a client whose project has stayed missing past the grace period", async () => {
    const now = new Date("2026-01-08T00:00:00Z");
    coolifyMocks.listCoolifyProjects.mockResolvedValue([]);
    dbMocks.organizationFindMany.mockResolvedValue([
      { id: "org-1", coolifyProjectId: "proj-gone", resourceMissingSince: new Date("2026-01-01T00:00:00Z") }
    ]);
    dbMocks.userFindFirst.mockResolvedValue({ id: "owner-1" });

    const result = await syncCoolifyProjectsToOrganizations({ now, graceDays: 7 });

    expect(dbMocks.transaction).toHaveBeenCalledTimes(1);
    expect(result.archived).toBe(1);
  });

  it("clears resourceMissingSince when a project reappears", async () => {
    coolifyMocks.listCoolifyProjects.mockResolvedValue([{ id: "proj-1", name: "Acme Co" }]);
    dbMocks.organizationFindMany.mockResolvedValue([
      { id: "org-1", coolifyProjectId: "proj-1", resourceMissingSince: new Date("2026-01-01T00:00:00Z") }
    ]);
    dbMocks.userFindFirst.mockResolvedValue({ id: "owner-1" });

    const result = await syncCoolifyProjectsToOrganizations();

    expect(dbMocks.organizationUpdate).toHaveBeenCalledWith({
      where: { id: "org-1" },
      data: { resourceMissingSince: null }
    });
    expect(result.missingSinceCleared).toBe(1);
  });

  it("refuses to archive an implausible share of clients at once", async () => {
    const now = new Date("2026-01-08T00:00:00Z");
    coolifyMocks.listCoolifyProjects.mockResolvedValue([]);
    dbMocks.organizationFindMany.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => ({
        id: `org-${i}`,
        coolifyProjectId: `proj-${i}`,
        resourceMissingSince: new Date("2026-01-01T00:00:00Z")
      }))
    );
    dbMocks.userFindFirst.mockResolvedValue({ id: "owner-1" });

    const result = await syncCoolifyProjectsToOrganizations({ now, graceDays: 7 });

    expect(dbMocks.transaction).not.toHaveBeenCalled();
    expect(result.archived).toBe(0);
    expect(result.archiveAborted).toBe(true);
  });
});
