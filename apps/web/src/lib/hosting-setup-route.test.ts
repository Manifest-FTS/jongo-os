import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ auth: vi.fn(), access: vi.fn(), ensure: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/auth.config", () => ({ auth: m.auth }));
vi.mock("@/lib/tenant-route-access", () => ({ resolveOrganizationAccess: m.access }));
vi.mock("@/lib/github-installations", () => ({ audit: m.audit }));
vi.mock("@/lib/organization-hosting", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./organization-hosting")>()),
  ensureOrganizationHostingProject: m.ensure
}));

vi.mock("@/lib/hosting-entitlement", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./hosting-entitlement")>()),
  checkHostingEntitlement: async () => ({ ok: true, via: "subscription" })
}));
import { POST } from "../app/api/organizations/[organizationId]/hosting/route";
import { explainHostingRefusal } from "./organization-hosting";

const ORG = "33333333-3333-4333-8333-333333333333";
const call = () => POST(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ organizationId: ORG }) });

beforeEach(() => {
  vi.clearAllMocks();
  m.auth.mockResolvedValue({ user: { id: "u1" } });
  m.access.mockResolvedValue({ isAdmin: true, isPlatformAdmin: false, organization: { id: ORG } });
});

describe("POST /api/organizations/[id]/hosting", () => {
  it("sets up hosting for a client admin", async () => {
    m.ensure.mockResolvedValue({ ok: true, projectUuid: "p1", created: true });
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe("Hosting is set up.");
    expect(m.audit).toHaveBeenCalled();
  });

  it("tells platform admins why hosting refused, and clients only plain words", async () => {
    m.ensure.mockResolvedValue({ ok: false, reason: "hosting_unavailable", message: "Hosting isn't reachable.", detail: explainHostingRefusal(403) });
    m.access.mockResolvedValue({ isAdmin: true, isPlatformAdmin: true, organization: { id: ORG } });
    const admin = await call();
    expect(admin.status).toBe(503);
    expect((await admin.json()).detail).toContain("write access");

    m.access.mockResolvedValue({ isAdmin: true, isPlatformAdmin: false, organization: { id: ORG } });
    const client = await (await call()).json();
    expect(client.detail).toBeNull();
    expect(client.message).toContain("first app");
  });

  it("is for client admins only", async () => {
    m.access.mockResolvedValue({ isAdmin: false, isPlatformAdmin: false, organization: { id: ORG } });
    expect((await call()).status).toBe(403);
    m.access.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
    m.auth.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
    expect(m.ensure).not.toHaveBeenCalled();
  });
});

describe("explainHostingRefusal", () => {
  it("turns each kind of refusal into something an admin can act on", () => {
    expect(explainHostingRefusal(401)).toContain("API token");
    expect(explainHostingRefusal(429)).toContain("rate-limiting");
    expect(explainHostingRefusal(502)).toContain("internal error");
    expect(explainHostingRefusal(undefined)).toContain("didn't answer");
  });
});
