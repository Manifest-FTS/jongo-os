import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  isPlatformAdmin: vi.fn(),
  orgAccess: vi.fn(),
  ensure: vi.fn(),
  remove: vi.fn(),
  rename: vi.fn(),
  hit: vi.fn(),
  org: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  site: { count: vi.fn() },
  queryRaw: vi.fn(),
  executeRaw: vi.fn()
}));

vi.mock("@/lib/auth.config", () => ({ auth: m.auth }));
vi.mock("@/lib/rbac", () => ({ isPlatformAdminUser: m.isPlatformAdmin }));
vi.mock("@/lib/tenant-route-access", () => ({ resolveOrganizationAccess: m.orgAccess }));
vi.mock("@/lib/coolify-project-import", () => ({ importLinkedCoolifyProjectSites: vi.fn() }));
vi.mock("@/lib/organization-hosting", () => ({
  ensureOrganizationHostingProject: m.ensure,
  removeOrganizationHostingProject: m.remove,
  renameOrganizationHostingProject: m.rename
}));
vi.mock("@/lib/auth-rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth-rate-limit")>()),
  hitRateLimit: m.hit
}));
vi.mock("@/lib/db", () => ({
  db: { organization: m.org, site: m.site, $queryRaw: m.queryRaw, $executeRaw: m.executeRaw }
}));

vi.mock("@/lib/hosting-entitlement", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./hosting-entitlement")>()),
  checkHostingEntitlement: async () => ({ ok: true, via: "subscription" })
}));
import { POST as createClient } from "../app/api/organizations/route";
import { DELETE as deleteClient } from "../app/api/organizations/[organizationId]/route";

const ORG = "33333333-3333-4333-8333-333333333333";
const params = { params: Promise.resolve({ organizationId: ORG }) };
const post = (body: unknown) =>
  new Request("http://localhost/api/organizations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

beforeEach(() => {
  vi.clearAllMocks();
  m.auth.mockResolvedValue({ user: { id: "user-a" } });
  m.isPlatformAdmin.mockResolvedValue(false);
  m.hit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  m.org.findUnique.mockResolvedValue(null);
  m.org.create.mockImplementation(async ({ data }: any) => ({ id: ORG, ...data }));
  m.ensure.mockResolvedValue({ ok: true, projectUuid: "proj-1", created: true });
  m.orgAccess.mockResolvedValue({
    organization: { id: ORG, ownerId: "user-a", name: "Acme", coolifyProjectId: "proj-1" },
    isAdmin: true,
    isPlatformAdmin: false
  });
});

describe("creating a client", () => {
  it("sets up its hosting project automatically", async () => {
    const res = await createClient(post({ name: "Acme Corp" }));
    expect(res.status).toBe(201);
    expect(m.ensure).toHaveBeenCalledWith(ORG);
    expect((await res.json()).hosting).toEqual({ ready: true, message: null });
  });

  it("still creates the client when hosting is down, and says what happens next", async () => {
    m.ensure.mockResolvedValue({ ok: false, reason: "hosting_unavailable", message: "x" });
    const res = await createClient(post({ name: "Acme Corp" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.hosting.ready).toBe(false);
    expect(body.hosting.message).toContain("first app");
  });

  it("is rate-limited per user, before anything is created", async () => {
    m.hit.mockResolvedValue({ allowed: false, retryAfterSeconds: 600 });
    const res = await createClient(post({ name: "Acme Corp" }));
    expect(res.status).toBe(429);
    expect(m.org.create).not.toHaveBeenCalled();
    expect(m.ensure).not.toHaveBeenCalled();
  });
});

describe("deleting a client", () => {
  it("refuses while it still has apps, so none are left running unseen", async () => {
    m.site.count.mockResolvedValue(2);
    const res = await deleteClient(new Request("http://localhost") as any, params);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("2 apps");
    expect(m.org.update).not.toHaveBeenCalled();
    expect(m.remove).not.toHaveBeenCalled();
  });

  it("deletes an empty client and tidies up its hosting project", async () => {
    m.site.count.mockResolvedValue(0);
    m.org.findUnique.mockResolvedValue({ coolifyProjectId: "proj-1" });
    const res = await deleteClient(new Request("http://localhost") as any, params);
    expect(res.status).toBe(200);
    expect(m.org.update).toHaveBeenCalledWith({ where: { id: ORG }, data: { deletedAt: expect.any(Date) } });
    expect(m.remove).toHaveBeenCalledWith(ORG, "proj-1");
  });

  it("is only for the owner", async () => {
    m.orgAccess.mockResolvedValue({ organization: { id: ORG, ownerId: "someone-else" }, isAdmin: true, isPlatformAdmin: false });
    const res = await deleteClient(new Request("http://localhost") as any, params);
    expect(res.status).toBe(403);
    expect(m.site.count).not.toHaveBeenCalled();
  });
});
