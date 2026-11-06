import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), isPlatformAdminUser: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/rbac", () => ({ isPlatformAdminUser: mocks.isPlatformAdminUser }));

import { grantCraftAccess, isCraftRole, listCraftAccess, resolveCraftAccess, revokeCraftAccess, type CraftRole } from "./craft-access";

const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SITE = id(1), ORG = id(2), OWNER = id(3), USER = id(4), ADMIN_USER = id(5), OTHER = id(6);
const FUTURE = new Date("2099-01-01T00:00:00Z");

type Scenario = {
  actor?: string;
  userDeleted?: boolean;
  siteDeleted?: boolean;
  orgDeleted?: boolean;
  ownerDeleted?: boolean;
  orgRole?: "admin" | "collaborator" | null;
  orgMemberDeleted?: boolean;
  siteCollaborator?: boolean;
  grant?: { role: string; revokedAt?: Date | null } | null;
  platformAdmin?: boolean;
  subscription?: "active" | "inactive";
};

let state: { audits: any[]; grants: any[]; users: Map<string, any> };

function build(s: Scenario = {}) {
  const actor = s.actor ?? USER;
  const owner = { id: OWNER, deletedAt: s.ownerDeleted ? new Date() : null, subscriptionPlanId: "core-sla",
    subscriptionStatus: s.subscription === "inactive" ? "canceled" : "active", subscriptionCurrentPeriodEnd: FUTURE };
  state = {
    audits: [],
    grants: s.grant ? [{ id: id(90), siteId: SITE, userId: actor, role: s.grant.role, revokedAt: s.grant.revokedAt ?? null, grantedByUserId: null, createdAt: new Date(), updatedAt: new Date() }] : [],
    users: new Map([
      [OWNER, { id: OWNER, email: "owner@example.com", emailVerified: true, fullName: "Owner", deletedAt: null }],
      [actor, { id: actor, email: "who@example.com", emailVerified: true, fullName: "Who", deletedAt: s.userDeleted ? new Date() : null }],
      [OTHER, { id: OTHER, email: "other@example.com", emailVerified: false, fullName: null, deletedAt: null }]
    ])
  };
  const tx = {
    user: { findUnique: async ({ where }: any) => state.users.get(where.id) ?? null },
    site: {
      findUnique: async ({ where }: any) => where.id !== SITE ? null : {
        id: SITE, organizationId: ORG, deletedAt: s.siteDeleted ? new Date() : null,
        organization: {
          id: ORG, ownerId: OWNER, deletedAt: s.orgDeleted ? new Date() : null, owner,
          collaborators: s.orgRole && !s.orgMemberDeleted ? [{ userId: actor, role: s.orgRole, deletedAt: null }] : []
        }
      }
    },
    siteCraftAccess: {
      findFirst: async ({ where }: any) => state.grants.find((g) => g.siteId === where.siteId && g.userId === where.userId && g.revokedAt === null) ?? null,
      findMany: async ({ where }: any) => state.grants.filter((g) => g.siteId === where.siteId && g.revokedAt === null).map((g) => ({ ...g, user: state.users.get(g.userId) ?? { email: "x", fullName: null, deletedAt: null } })),
      create: async ({ data }: any) => {
        if (state.grants.some((g) => g.siteId === data.siteId && g.userId === data.userId && g.revokedAt === null)) throw Object.assign(new Error("unique"), { code: "P2002" });
        const row = { id: id(100 + state.grants.length), revokedAt: null, createdAt: new Date(), updatedAt: new Date(), ...data };
        state.grants.push(row);
        return row;
      },
      update: async ({ where, data }: any) => Object.assign(state.grants.find((g) => g.id === where.id)!, data),
      updateMany: async ({ where, data }: any) => {
        const rows = state.grants.filter((g) => g.siteId === where.siteId && g.userId === where.userId && g.revokedAt === null);
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      }
    },
    auditLog: { create: async ({ data }: any) => { state.audits.push(data); } }
  };
  mocks.getDb.mockResolvedValue({ $transaction: async (fn: any) => fn(tx) });
  mocks.isPlatformAdminUser.mockImplementation(async (userId: string) => Boolean(s.platformAdmin) && userId === actor);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("JONGO_CMS_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

const resolve = (s: Scenario = {}) => { build(s); return resolveCraftAccess(s.actor ?? USER, SITE); };

describe("effective Craft role", () => {
  it("platform admin gets admin everywhere, via platform_admin", async () => {
    expect(await resolve({ platformAdmin: true })).toMatchObject({ role: "admin", via: "platform_admin", siteId: SITE, organizationId: ORG });
  });

  it("organization owner is admin via org_owner", async () => {
    expect(await resolve({ actor: OWNER })).toMatchObject({ role: "admin", via: "org_owner" });
  });

  it("organization admin (Collaborator.role=admin) is admin via org_admin", async () => {
    expect(await resolve({ orgRole: "admin" })).toMatchObject({ role: "admin", via: "org_admin" });
  });

  it("an organization collaborator WITHOUT an explicit grant has no access", async () => {
    expect(await resolve({ orgRole: "collaborator" })).toBeNull();
  });

  it("a site-level collaborator without a grant and a stranger have no access", async () => {
    expect(await resolve({ siteCollaborator: true })).toBeNull();
    expect(await resolve({})).toBeNull();
  });

  it.each(["reader", "editor", "publisher", "admin"] as CraftRole[])("an organization collaborator with an explicit %s grant gets exactly that role", async (role) => {
    expect(await resolve({ orgRole: "collaborator", grant: { role } })).toMatchObject({ role, via: "site_grant", capped: false });
  });

  it.each(["reader", "editor", "publisher", "admin"] as CraftRole[])("a non-member with an explicit %s grant gets that role (grants are per app, not membership)", async (role) => {
    expect(await resolve({ grant: { role } })).toMatchObject({ role, via: "site_grant" });
  });

  it("a revoked grant gives nothing", async () => {
    expect(await resolve({ orgRole: "collaborator", grant: { role: "admin", revokedAt: new Date() } })).toBeNull();
  });

  it("an unknown stored role is ignored", async () => {
    expect(await resolve({ grant: { role: "owner" } })).toBeNull();
  });

  it("takes the highest of grant and org role, and reports the tenant reason on ties", async () => {
    expect(await resolve({ orgRole: "admin", grant: { role: "editor" } })).toMatchObject({ role: "admin", via: "org_admin" });
    expect(await resolve({ orgRole: "admin", platformAdmin: true })).toMatchObject({ role: "admin", via: "org_admin" });
    expect(await resolve({ actor: OWNER, platformAdmin: true })).toMatchObject({ via: "org_owner" });
    expect(await resolve({ grant: { role: "admin" }, platformAdmin: true })).toMatchObject({ via: "site_grant" });
    expect(await resolve({ grant: { role: "editor" }, platformAdmin: true })).toMatchObject({ role: "admin", via: "platform_admin" });
  });

  it("never returns owner as a role", async () => {
    for (const s of [{ actor: OWNER }, { platformAdmin: true }, { orgRole: "admin" as const }]) {
      expect(isCraftRole((await resolve(s))?.role)).toBe(true);
      expect((await resolve(s))?.role).not.toBe("owner");
    }
  });

  it("denies a deleted user, even a platform admin or owner", async () => {
    expect(await resolve({ userDeleted: true, platformAdmin: true })).toBeNull();
    expect(await resolve({ actor: OWNER, userDeleted: true })).toBeNull();
    expect(await resolve({ userDeleted: true, grant: { role: "admin" } })).toBeNull();
  });

  it("denies a deleted site or deleted organization for everyone", async () => {
    expect(await resolve({ siteDeleted: true, platformAdmin: true })).toBeNull();
    expect(await resolve({ siteDeleted: true, actor: OWNER })).toBeNull();
    expect(await resolve({ orgDeleted: true, grant: { role: "admin" } })).toBeNull();
    expect(await resolve({ orgDeleted: true, orgRole: "admin" })).toBeNull();
  });

  it("denies when the organization owner (sponsor) is deleted", async () => {
    expect(await resolve({ ownerDeleted: true, orgRole: "admin" })).toBeNull();
    expect(await resolve({ ownerDeleted: true, platformAdmin: true })).toBeNull();
  });

  it("denies an unknown site and malformed ids without touching the database", async () => {
    build();
    expect(await resolveCraftAccess(USER, id(99))).toBeNull();
    mocks.getDb.mockClear();
    expect(await resolveCraftAccess("not-a-uuid", SITE)).toBeNull();
    expect(await resolveCraftAccess(USER, "not-a-uuid")).toBeNull();
    expect(await resolveCraftAccess(USER, undefined as unknown as string)).toBeNull();
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("denies when the database is unavailable or throws", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(await resolveCraftAccess(USER, SITE)).toBeNull();
    mocks.getDb.mockRejectedValue(new Error("boom"));
    expect(await resolveCraftAccess(USER, SITE)).toBeNull();
  });
});

describe("entitlement (same denial as resolveDatasetCmsCapabilities)", () => {
  it("keeps read but caps everyone but a platform admin to reader when the owner subscription is not active", async () => {
    for (const s of [{ actor: OWNER }, { orgRole: "admin" as const }, { grant: { role: "publisher" } }]) {
      expect(await resolve({ ...s, subscription: "inactive" })).toMatchObject({ role: "reader", capped: true });
    }
  });

  it("never caps a platform admin: the owner's missing subscription does not limit them", async () => {
    expect(await resolve({ platformAdmin: true, subscription: "inactive" })).toMatchObject({ role: "admin", via: "platform_admin", capped: false });
    // Still denied when the owner is gone: read capacity is required for everyone.
    expect(await resolve({ platformAdmin: true, ownerDeleted: true, subscription: "inactive" })).toBeNull();
  });

  it("does not report capped for an explicit reader", async () => {
    expect(await resolve({ grant: { role: "reader" }, subscription: "inactive" })).toMatchObject({ role: "reader", capped: false });
  });

  it("denies everything while JONGO_CMS_ENABLED is not exactly true", async () => {
    for (const value of [undefined, "", "TRUE", "1", "false"]) {
      if (value === undefined) vi.stubEnv("JONGO_CMS_ENABLED", ""); else vi.stubEnv("JONGO_CMS_ENABLED", value);
      expect(await resolve({ actor: OWNER })).toBeNull();
      expect(await resolve({ platformAdmin: true })).toBeNull();
    }
  });

  it("returns the identity data needed for claims", async () => {
    expect((await resolve({ grant: { role: "editor" } }))?.user).toEqual({ id: USER, email: "who@example.com", emailVerified: true, name: "Who" });
  });
});

describe("grant management", () => {
  it("lets platform admin, owner and org admin grant; nobody else", async () => {
    for (const [s, ok] of [[{ platformAdmin: true }, true], [{ actor: OWNER }, true], [{ orgRole: "admin" as const }, true],
      [{ orgRole: "collaborator" as const }, false], [{ siteCollaborator: true }, false], [{ grant: { role: "admin" } }, false], [{}, false]] as Array<[Scenario, boolean]>) {
      build(s);
      const result = await grantCraftAccess({ actorId: s.actor ?? USER, siteId: SITE, userId: OTHER, role: "editor" });
      expect(result.ok, JSON.stringify(s)).toBe(ok);
      if (!ok) expect(result).toEqual({ ok: false, reason: "forbidden" });
    }
  });

  it("creates then updates one active grant, auditing each", async () => {
    build({ actor: OWNER });
    const first = await grantCraftAccess({ actorId: OWNER, siteId: SITE, userId: OTHER, role: "reader" });
    expect(first).toMatchObject({ ok: true, created: true });
    const second = await grantCraftAccess({ actorId: OWNER, siteId: SITE, userId: OTHER, role: "publisher" });
    expect(second).toMatchObject({ ok: true, created: false });
    expect(state.grants.filter((g) => g.userId === OTHER && g.revokedAt === null)).toHaveLength(1);
    expect(state.grants[0]).toMatchObject({ role: "publisher", grantedByUserId: OWNER });
    expect(state.audits.map((a) => a.action)).toEqual(["craft.access.grant", "craft.access.grant"]);
    expect(state.audits[0]).toMatchObject({ organizationId: ORG, actorId: OWNER, resourceType: "site", resourceId: SITE, details: { targetUserId: OTHER, role: "reader" } });
  });

  it("rejects invalid roles, ids, deleted targets and unknown sites", async () => {
    build({ actor: OWNER });
    for (const role of ["owner", "superuser", "", undefined, 3]) {
      expect(await grantCraftAccess({ actorId: OWNER, siteId: SITE, userId: OTHER, role })).toEqual({ ok: false, reason: "invalid" });
    }
    expect(await grantCraftAccess({ actorId: "x", siteId: SITE, userId: OTHER, role: "reader" })).toEqual({ ok: false, reason: "invalid" });
    state.users.set(OTHER, { ...state.users.get(OTHER), deletedAt: new Date() });
    expect(await grantCraftAccess({ actorId: OWNER, siteId: SITE, userId: OTHER, role: "reader" })).toEqual({ ok: false, reason: "not_found" });
    expect(await grantCraftAccess({ actorId: OWNER, siteId: id(77), userId: id(8), role: "reader" })).toEqual({ ok: false, reason: "not_found" });
    expect(state.grants).toHaveLength(0);
  });

  it("retries once when a concurrent grant wins the unique index", async () => {
    build({ actor: OWNER });
    const real = (await mocks.getDb()) as { $transaction: (fn: any) => Promise<unknown> };
    let first = true;
    mocks.getDb.mockResolvedValue({
      $transaction: async (fn: any) => {
        if (first) {
          first = false;
          state.grants.push({ id: id(500), siteId: SITE, userId: OTHER, role: "reader", revokedAt: null });
          throw Object.assign(new Error("unique"), { code: "P2002" });
        }
        return real.$transaction(fn);
      }
    });
    expect(await grantCraftAccess({ actorId: OWNER, siteId: SITE, userId: OTHER, role: "editor" })).toMatchObject({ ok: true, created: false });
    expect(state.grants.filter((g) => g.revokedAt === null)).toHaveLength(1);
  });

  it("revokes active grants only for managers and audits it", async () => {
    build({ actor: OWNER });
    await grantCraftAccess({ actorId: OWNER, siteId: SITE, userId: OTHER, role: "editor" });
    expect(await revokeCraftAccess({ actorId: OWNER, siteId: SITE, userId: OTHER })).toEqual({ ok: true, revoked: true });
    expect(await revokeCraftAccess({ actorId: OWNER, siteId: SITE, userId: OTHER })).toEqual({ ok: true, revoked: false });
    expect(state.audits.map((a) => a.action)).toEqual(["craft.access.grant", "craft.access.revoke"]);
    build({ orgRole: "collaborator" });
    expect(await revokeCraftAccess({ actorId: USER, siteId: SITE, userId: OTHER })).toEqual({ ok: false, reason: "forbidden" });
  });

  it("a user can be granted again after a revocation (history kept)", async () => {
    build({ actor: OWNER });
    await grantCraftAccess({ actorId: OWNER, siteId: SITE, userId: OTHER, role: "editor" });
    await revokeCraftAccess({ actorId: OWNER, siteId: SITE, userId: OTHER });
    expect(await grantCraftAccess({ actorId: OWNER, siteId: SITE, userId: OTHER, role: "reader" })).toMatchObject({ ok: true, created: true });
    expect(state.grants).toHaveLength(2);
    expect(state.grants.filter((g) => g.revokedAt === null)).toHaveLength(1);
  });

  it("lists active grants for managers only", async () => {
    build({ actor: OWNER });
    await grantCraftAccess({ actorId: OWNER, siteId: SITE, userId: OTHER, role: "editor" });
    const listed = await listCraftAccess(OWNER, SITE);
    expect(listed).toMatchObject({ ok: true, entries: [{ userId: OTHER, email: "other@example.com", role: "editor" }] });
    build({ grant: { role: "admin" } });
    expect(await listCraftAccess(USER, SITE)).toEqual({ ok: false, reason: "forbidden" });
  });
});
