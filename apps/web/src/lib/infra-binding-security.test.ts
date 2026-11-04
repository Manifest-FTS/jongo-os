import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  isPlatformAdmin: vi.fn(),
  orgAccess: vi.fn(),
  importSites: vi.fn(),
  overview: vi.fn(),
  provision: vi.fn(),
  backups: vi.fn(),
  org: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  site: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  queryRaw: vi.fn(),
  executeRaw: vi.fn()
}));

vi.mock("@/lib/auth.config", () => ({ auth: m.auth }));
vi.mock("@/lib/rbac", () => ({ isPlatformAdminUser: m.isPlatformAdmin }));
vi.mock("@/lib/tenant-route-access", () => ({ resolveOrganizationAccess: m.orgAccess }));
vi.mock("@/lib/coolify-project-import", () => ({ importLinkedCoolifyProjectSites: m.importSites }));
vi.mock("@/lib/organization-hosting", () => ({
  ensureOrganizationHostingProject: async (id: string) => ({ ok: true, projectUuid: `project-of-${id}`, created: true })
}));
vi.mock("@/lib/coolify", () => ({
  getCoolifyOverview: m.overview,
  provisionCoolifyWordPressService: m.provision,
  ensureCoolifyAppBackupSchedules: m.backups
}));
vi.mock("@/lib/db", () => ({
  db: {
    organization: m.org,
    site: m.site,
    $queryRaw: m.queryRaw,
    $executeRaw: m.executeRaw
  }
}));

import { POST as createOrganization } from "../app/api/organizations/route";
import { POST as createSite } from "../app/api/organizations/[organizationId]/sites/route";

const ORG = "33333333-3333-4333-8333-333333333333";

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}
const params = { params: Promise.resolve({ organizationId: ORG }) };

beforeEach(() => {
  vi.clearAllMocks();
  m.auth.mockResolvedValue({ user: { id: "user-a", email: "a@example.com" } });
  m.isPlatformAdmin.mockResolvedValue(false);
  m.org.findUnique.mockResolvedValue(null);
  m.org.create.mockImplementation(async ({ data }: any) => ({ id: ORG, ...data }));
  m.queryRaw.mockResolvedValue([]);
  m.orgAccess.mockResolvedValue({
    organization: { id: ORG, ownerId: "user-a", coolifyProjectId: "own-project" },
    isAdmin: true,
    isPlatformAdmin: false
  });
  m.site.findMany.mockResolvedValue([]);
  m.site.findFirst.mockResolvedValue(null);
  m.overview.mockResolvedValue({ sites: [] });
});

describe("POST /api/organizations — hosting project claim", () => {
  it("refuses a non-admin claiming a hosting project", async () => {
    const res = await createOrganization(jsonRequest({ name: "Acme", coolifyProjectId: "victim-project" }));
    expect(res.status).toBe(403);
    expect(m.org.create).not.toHaveBeenCalled();
    expect(m.importSites).not.toHaveBeenCalled();
  });

  it("still lets anyone create a plain organization", async () => {
    const res = await createOrganization(jsonRequest({ name: "Acme" }));
    expect(res.status).toBeLessThan(300);
    expect(m.org.create).toHaveBeenCalled();
    expect(m.importSites).not.toHaveBeenCalled();
  });

  it("lets a platform admin link a project", async () => {
    m.isPlatformAdmin.mockResolvedValue(true);
    const res = await createOrganization(jsonRequest({ name: "Acme", coolifyProjectId: "unlinked-project" }));
    expect(res.status).toBeLessThan(300);
    expect(m.org.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ coolifyProjectId: "unlinked-project" }) })
    );
  });
});

describe("POST /api/organizations/[id]/sites — adopting a hosting resource", () => {
  it("refuses a client admin adopting an existing resource", async () => {
    const res = await createSite(jsonRequest({ name: "Stolen", coolifyServiceUuid: "victim-uuid" }), params);
    expect(res.status).toBe(403);
    expect(m.site.create).not.toHaveBeenCalled();
    expect(m.org.update).not.toHaveBeenCalled();
  });

  it("refuses callers without admin access to the client", async () => {
    m.orgAccess.mockResolvedValue(null);
    const res = await createSite(jsonRequest({ name: "x" }), params);
    expect(res.status).toBe(404);
  });

  it("refuses non-admin members a bare record with no hosting behind it", async () => {
    m.orgAccess.mockResolvedValue({ organization: { id: ORG, ownerId: "someone", coolifyProjectId: null }, isAdmin: false, isPlatformAdmin: false });
    const res = await createSite(jsonRequest({ name: "x" }), params);
    expect(res.status).toBe(403);
    expect(m.provision).not.toHaveBeenCalled();
  });

  it("lets collaborators create a new WordPress site", async () => {
    m.orgAccess.mockResolvedValue({ organization: { id: ORG, ownerId: "someone", coolifyProjectId: "own-project" }, isAdmin: false, isPlatformAdmin: false });
    m.provision.mockResolvedValue({ ok: true, uuid: "new-wp", message: "App created." });
    const res = await createSite(jsonRequest({ name: "Blog", provisionWordPress: true }), params);
    expect(res.status).not.toBe(403);
    expect(m.provision).toHaveBeenCalledWith(expect.objectContaining({ name: "Blog", projectUuid: "project-of-33333333-3333-4333-8333-333333333333" }));
  });

  it("still refuses collaborators adopting a running resource, even alongside WordPress", async () => {
    m.orgAccess.mockResolvedValue({ organization: { id: ORG, ownerId: "someone", coolifyProjectId: null }, isAdmin: false, isPlatformAdmin: false });
    const res = await createSite(jsonRequest({ name: "x", provisionWordPress: true, coolifyServiceUuid: "victim-uuid" }), params);
    expect(res.status).toBe(403);
    expect(m.provision).not.toHaveBeenCalled();
  });

  it("refuses even a platform admin when another client already holds the resource", async () => {
    m.orgAccess.mockResolvedValue({ organization: { id: ORG, ownerId: "admin", coolifyProjectId: null }, isAdmin: true, isPlatformAdmin: true });
    m.site.findFirst.mockResolvedValueOnce({ id: "other-site" });
    const res = await createSite(jsonRequest({ name: "Dup", coolifyServiceUuid: "held-uuid" }), params);
    expect(res.status).toBe(409);
    expect(m.site.create).not.toHaveBeenCalled();
  });
});
