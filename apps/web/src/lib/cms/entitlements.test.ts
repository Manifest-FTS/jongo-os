import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  getDb: vi.fn(), user: vi.fn(), organization: vi.fn(), collaborator: vi.fn(), grant: vi.fn()
}));
vi.mock("@/lib/db", () => ({ getDb: m.getDb }));
// Use the REAL resolvePrincipal: bootstrap/global/grant behavior must not bypass tenant checks.
import {
  evaluateCmsEntitlement, resolveOrganizationCmsCapabilities,
  type CmsFeature, type CmsPolicyInput, type CmsSponsorState
} from "./entitlements";

const now = new Date("2026-10-19T12:00:00.000Z");
const end = new Date("2026-10-20T12:00:00.000Z");
const features: CmsFeature[] = ["cms.read", "cms.author", "cms.schema.customize"];
function sponsor(): CmsSponsorState {
  return { id: "owner", deletedAt: null, subscriptionPlanId: "enterprise-sla",
    subscriptionStatus: "active", subscriptionCurrentPeriodEnd: end };
}
function policy(overrides: Partial<CmsPolicyInput> = {}): CmsPolicyInput {
  return { feature: "cms.author", organizationId: "org-a", enabled: true, now,
    scope: { userId: "owner", organizationId: "org-a", ownerId: "owner", role: "owner" },
    sponsor: sponsor(), ...overrides };
}
const deniedFeatures = { "cms.read": false, "cms.author": false, "cms.schema.customize": false };

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("pure organization CMS capacity policy", () => {
  it.each([
    ["starter", false, false], ["pro", false, false],
    ["core-sla", true, false], ["enterprise-sla", true, true],
    ["studio", false, false], ["scale", false, false], ["Studio", false, false],
    ["Scale", false, false], ["CORE-SLA", false, false], ["enterprise-sla ", false, false],
    ["unknown", false, false], ["constructor", false, false], ["__proto__", false, false],
    [null, false, false]
  ])("uses only reviewed stable plan ID %s", (plan, author, customize) => {
    const state = { ...sponsor(), subscriptionPlanId: plan as string | null };
    expect(features.map((feature) => evaluateCmsEntitlement(policy({ feature, sponsor: state }))))
      .toEqual([true, author, customize]);
  });

  it.each(["past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "paused",
    "trialing", "expired", "ACTIVE", "", null])("locks writes but retains read/export for %s", (status) => {
    const state = { ...sponsor(), subscriptionStatus: status };
    expect(features.map((feature) => evaluateCmsEntitlement(policy({ feature, sponsor: state }))))
      .toEqual([true, false, false]);
  });

  it.each([
    [new Date(now.getTime() + 1), true], [now, false], [new Date(now.getTime() - 1), false],
    [new Date("invalid"), false], [null, false]
  ])("requires a valid strictly future paid end %s", (period, expected) => {
    for (const feature of ["cms.author", "cms.schema.customize"] as const) {
      expect(evaluateCmsEntitlement(policy({ feature, sponsor: {
        ...sponsor(), subscriptionCurrentPeriodEnd: period as Date | null
      } }))).toBe(expected);
    }
    expect(evaluateCmsEntitlement(policy({ feature: "cms.read", sponsor: {
      ...sponsor(), subscriptionCurrentPeriodEnd: period as Date | null
    } }))).toBe(true);
  });

  it("honors period-end cancellation while persisted status remains active", () => {
    expect(evaluateCmsEntitlement(policy())).toBe(true);
    expect(evaluateCmsEntitlement(policy({ now: end }))).toBe(false);
    expect(evaluateCmsEntitlement(policy({ now: new Date("invalid") }))).toBe(false);
    expect(evaluateCmsEntitlement(policy({ sponsor: {
      ...sponsor(), subscriptionCurrentPeriodEnd: end.toISOString() as unknown as Date
    } }))).toBe(false);
  });

  it.each(["owner", "admin", "collaborator"] as const)("restricts %s to its explicit tenant role", (role) => {
    const scope = { organizationId: "org-a", ownerId: "owner", userId: role === "owner" ? "owner" : "actor", role };
    expect(features.map((feature) => evaluateCmsEntitlement(policy({ feature, scope }))))
      .toEqual([true, role === "owner", role === "owner"]);
  });

  it("rejects spoofed owners, cross-org scope, missing/deleted/mismatched sponsors and invalid roles", () => {
    const base = policy();
    const invalid: Partial<CmsPolicyInput>[] = [
      { scope: null }, { sponsor: null }, { organizationId: "org-b" }, { organizationId: "" },
      { scope: { ...base.scope!, userId: "attacker" } },
      { scope: { ...base.scope!, userId: "" } },
      { scope: { ...base.scope!, role: "super_admin" as "owner" } },
      { sponsor: { ...sponsor(), id: "actor" } },
      { sponsor: { ...sponsor(), deletedAt: now } }
    ];
    for (const input of invalid) for (const feature of features) {
      expect(evaluateCmsEntitlement(policy({ ...input, feature }))).toBe(false);
    }
    expect(evaluateCmsEntitlement(policy({ feature: "cms.publish" as CmsFeature }))).toBe(false);
    expect(evaluateCmsEntitlement(policy({ enabled: false }))).toBe(false);
  });
});

describe("fresh server organization capability scaffold", () => {
  let actor: Record<string, unknown> | null;
  let owner: CmsSponsorState | null;
  let org: { id: string; ownerId: string; deletedAt: Date | null } | null;
  let membership: { organizationId: string; userId: string; role: string; deletedAt: Date | null } | null;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.stubEnv("JONGO_CMS_ENABLED", "true");
    vi.stubEnv("BOOTSTRAP_ADMIN_EMAIL", "");
    actor = { id: "owner", email: "actor@example.test", role: "collaborator", deletedAt: null,
      subscriptionPlanId: "enterprise-sla", subscriptionStatus: "active", subscriptionCurrentPeriodEnd: end };
    owner = sponsor();
    org = { id: "org-a", ownerId: "owner", deletedAt: null };
    membership = null;
    m.getDb.mockResolvedValue({
      user: { findUnique: m.user }, organization: { findUnique: m.organization },
      collaborator: { findFirst: m.collaborator }, platformAdmin: { findUnique: m.grant }
    });
    m.grant.mockResolvedValue(null);
    m.user.mockImplementation(async ({ where, select }) => {
      if (select.subscriptionPlanId) return where.id === owner?.id ? owner : null;
      return where.id === actor?.id ? actor : null;
    });
    m.organization.mockImplementation(async ({ where }) => where.id === org?.id ? org : null);
    m.collaborator.mockImplementation(async ({ where }) =>
      membership && Object.entries(where).every(([key, value]) => membership![key as keyof typeof membership] === value)
        ? membership : null);
  });

  const resolve = (user = "owner", organization = "org-a") => resolveOrganizationCmsCapabilities(user, organization);
  async function expectDenied(user = "owner", organization = "org-a") {
    expect((await resolve(user, organization)).features).toEqual(deniedFeatures);
  }
  function collaborator(role = "collaborator") {
    actor!.id = "actor";
    membership = { userId: "actor", organizationId: "org-a", deletedAt: null, role };
  }

  it("returns only sanitized org capacities, explicitly NOT dataset or mutation authorization", async () => {
    expect(await resolve()).toEqual({ scope: "organization", organizationId: "org-a",
      requiresBoundDataset: true, mutationsEnabled: false,
      features: { "cms.read": true, "cms.author": true, "cms.schema.customize": true } });
    expect(m.user).toHaveBeenCalledWith({ where: { id: "owner" }, select: {
      id: true, deletedAt: true, subscriptionPlanId: true, subscriptionStatus: true,
      subscriptionCurrentPeriodEnd: true
    } });
    expect(JSON.stringify(await resolve())).not.toMatch(/subscription|stripe|billing|email|ownerId|enterprise-sla/);
    expect(m.organization.mock.calls[0][0].select).toEqual({ id: true, ownerId: true, deletedAt: true });
  });

  it.each([undefined, "", "false", "TRUE", "True", "1", " true", "true "])("defaults off unless flag is exact true: %s", async (flag) => {
    vi.stubEnv("JONGO_CMS_ENABLED", flag);
    await expectDenied();
    expect(m.getDb).not.toHaveBeenCalled();
  });

  it.each(["collaborator", "admin"])("keeps org %s read-only regardless of its own paid plan", async (role) => {
    collaborator(role);
    expect((await resolve("actor")).features).toEqual({ "cms.read": true, "cms.author": false, "cms.schema.customize": false });
    expect(m.collaborator).toHaveBeenCalledWith({
      where: { organizationId: "org-a", userId: "actor", deletedAt: null },
      select: { organizationId: true, userId: true, role: true, deletedAt: true }
    });
    owner!.subscriptionPlanId = "starter";
    expect((await resolve("actor")).features["cms.author"]).toBe(false);
    expect(m.user.mock.calls.filter(([query]) => query.select.subscriptionPlanId)
      .every(([query]) => query.where.id === "owner")).toBe(true);
  });

  it.each(["super_admin", "admin", "bootstrap", "platform-grant"])("does not turn %s technical authority into content access", async (kind) => {
    actor!.id = "outsider";
    if (kind === "bootstrap") vi.stubEnv("BOOTSTRAP_ADMIN_EMAIL", actor!.email as string);
    else if (kind === "platform-grant") m.grant.mockResolvedValue({ id: "grant" });
    else actor!.role = kind;
    await expectDenied("outsider");
    expect(m.collaborator).toHaveBeenCalled();
  });

  it.each(["super_admin", "admin", "collaborator"])("does not let owner global %s override the persisted sponsor tier/status", async (role) => {
    actor!.role = role;
    owner!.subscriptionPlanId = "pro";
    expect((await resolve()).features).toEqual({ "cms.read": true, "cms.author": false, "cms.schema.customize": false });
    owner!.subscriptionPlanId = "enterprise-sla";
    owner!.subscriptionStatus = "canceled";
    expect((await resolve()).features["cms.author"]).toBe(false);
  });

  it("rereads subscription, expiry, tenant membership and principal on every call", async () => {
    expect((await resolve()).features["cms.author"]).toBe(true);
    owner!.subscriptionStatus = "past_due";
    expect((await resolve()).features["cms.author"]).toBe(false);
    owner!.subscriptionStatus = "active";
    vi.setSystemTime(end);
    expect((await resolve()).features["cms.author"]).toBe(false);
    collaborator("admin");
    expect((await resolve("actor")).features["cms.read"]).toBe(true);
    membership = null;
    await expectDenied("actor");
    actor = null;
    await expectDenied("actor");
  });

  it.each(["missing actor", "deleted actor", "missing owner", "deleted owner", "missing org", "deleted org",
    "DB absent", "DB throws", "schema error", "sponsor query error"])("fails closed without mock fallback: %s", async (kind) => {
    if (kind === "missing actor") actor = null;
    if (kind === "deleted actor") actor!.deletedAt = now;
    if (kind === "missing owner") owner = null;
    if (kind === "deleted owner") owner!.deletedAt = now;
    if (kind === "missing org") org = null;
    if (kind === "deleted org") org!.deletedAt = now;
    if (kind === "DB absent") m.getDb.mockResolvedValue(null);
    if (kind === "DB throws") m.getDb.mockRejectedValue(new Error("offline"));
    if (kind === "schema error") m.organization.mockRejectedValue(new Error("missing column"));
    if (kind === "sponsor query error") m.user.mockImplementation(async ({ select }) => {
      if (select.subscriptionPlanId) throw new Error("missing subscription column");
      return actor;
    });
    await expectDenied();
  });

  it("fails closed if DB disappears after principal resolution", async () => {
    m.getDb.mockResolvedValueOnce(await m.getDb()).mockResolvedValueOnce(null);
    await expectDenied();
    expect(m.organization).not.toHaveBeenCalled();
  });

  it("rejects absent IDs, other orgs, site-only/revoked/cross-org and injected owner memberships", async () => {
    await expectDenied("");
    await expectDenied("owner", "");
    await expectDenied("owner", "org-b");
    collaborator();
    membership = null; // SiteCollaborator is deliberately never queried.
    await expectDenied("actor");
    collaborator();
    membership!.deletedAt = now;
    await expectDenied("actor");
    collaborator();
    membership!.organizationId = "org-b";
    await expectDenied("actor");
    collaborator("owner");
    await expectDenied("actor");
  });
});