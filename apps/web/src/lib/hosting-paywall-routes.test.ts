import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ auth: vi.fn(), access: vi.fn(), provision: vi.fn(), entitlement: vi.fn(), requireMember: vi.fn(), createRepo: vi.fn() }));
vi.mock("@/lib/auth.config", () => ({ auth: m.auth }));
vi.mock("@/lib/tenant-route-access", () => ({ resolveOrganizationAccess: m.access }));
vi.mock("@/lib/coolify", () => ({ provisionCoolifyWordPressService: m.provision, getCoolifyOverview: vi.fn(), ensureCoolifyAppBackupSchedules: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { site: { findFirst: vi.fn(), findMany: vi.fn(async () => []) } } }));
vi.mock("@/lib/github-route-access", () => ({ requireOrgMember: m.requireMember }));
vi.mock("@/lib/github-deploys", () => ({ createSiteFromGithub: m.createRepo, createSiteFromPublicRepo: m.createRepo, createSiteFromDeployKey: m.createRepo }));
vi.mock("@/lib/hosting-entitlement", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./hosting-entitlement")>()),
  checkHostingEntitlement: m.entitlement
}));

import { POST as createWordPress } from "../app/api/organizations/[organizationId]/sites/route";
import { POST as createFromRepo } from "../app/api/organizations/[organizationId]/sites/github/route";

const ORG = "33333333-3333-4333-8333-333333333333";
const params = { params: Promise.resolve({ organizationId: ORG }) };
const req = (body: unknown) => new Request("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  m.auth.mockResolvedValue({ user: { id: "owner" } });
  m.access.mockResolvedValue({ organization: { id: ORG, ownerId: "owner", coolifyProjectId: "p" }, isAdmin: true, isPlatformAdmin: false });
  m.requireMember.mockResolvedValue({ userId: "owner", email: null });
  m.entitlement.mockResolvedValue({ ok: false, reason: "payment_required", actorIsOwner: true, message: "Choose a plan to start hosting apps." });
});

describe("no new hosting without a plan", () => {
  it("refuses a new WordPress site with 402 and a link to plans, before touching hosting", async () => {
    const res = await createWordPress(req({ name: "Blog", provisionWordPress: true }), params);
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ reason: "payment_required", actionUrl: "/pricing" });
    expect(m.provision).not.toHaveBeenCalled();
  });

  it("refuses an app from a repository the same way", async () => {
    const res = await createFromRepo(req({ name: "Shop", mode: "public", repoUrl: "https://github.com/a/b", branch: "main" }), params);
    expect(res.status).toBe(402);
    expect(m.createRepo).not.toHaveBeenCalled();
  });
});
