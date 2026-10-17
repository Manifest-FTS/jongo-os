import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(), isSuperAdminUser: vi.fn(), users: vi.fn(), userCount: vi.fn(),
  invites: vi.fn(), inviteCount: vi.fn(), roleCounts: vi.fn()
}));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/rbac", () => ({ isSuperAdminUser: mocks.isSuperAdminUser }));
import { AccessDirectoryError, getAccessDirectory } from "./access-directory";

describe("super-admin access directory", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.isSuperAdminUser.mockResolvedValue(true);
    mocks.getDb.mockResolvedValue({
      user: { findMany: mocks.users, count: mocks.userCount, groupBy: mocks.roleCounts },
      invitation: { findMany: mocks.invites, count: mocks.inviteCount }
    });
    mocks.users.mockResolvedValue([]);
    mocks.userCount.mockResolvedValue(0);
    mocks.invites.mockResolvedValue([]);
    mocks.inviteCount.mockResolvedValue(0);
    mocks.roleCounts.mockResolvedValue([
      { role: "super_admin", _count: { _all: 1 } },
      { role: "admin", _count: { _all: 2 } }
    ]);
  });

  it("requires a signed-in, fresh database super-admin before querying access data", async () => {
    await expect(getAccessDirectory(null)).rejects.toMatchObject({ status: 401 });
    mocks.isSuperAdminUser.mockResolvedValue(false);
    await expect(getAccessDirectory("admin-id")).rejects.toMatchObject({ status: 403 });
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.users).not.toHaveBeenCalled();
  });

  it("fails closed when directory storage is unavailable", async () => {
    mocks.getDb.mockResolvedValue(null);
    await expect(getAccessDirectory("super-id")).rejects.toMatchObject({ status: 503 });
  });

  it("maps global platform authority separately from client and app memberships", async () => {
    mocks.users.mockResolvedValue([{
      id: "u1", email: "admin@example.test", fullName: "Ada", role: "collaborator", createdAt: new Date("2026-01-01"),
      platformAdminGrant: { id: "grant" },
      organizations: [{ id: "owned", name: "Owned client", slug: "owned", _count: { sites: 3 } }],
      collaborations: [{ role: "admin", organization: { id: "member", name: "Member client", slug: "member", _count: { sites: 2 } } }],
      siteCollaborations: [{ role: "collaborator", site: { id: "site", name: "App", slug: "app", organization: { id: "member", name: "Member client", slug: "member" } } }]
    }]);
    mocks.invites.mockResolvedValue([{
      id: "invite", email: "new@example.test", role: "collaborator", inviteType: "site", createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
      organization: { id: "member", name: "Member client", slug: "member" }, site: { id: "site", name: "App", slug: "app" }
    }]);

    const result = await getAccessDirectory("super-id");
    expect(result.users[0]).toMatchObject({
      role: "collaborator", platformAccess: true, platformAccessSources: ["platform admin grant"],
      ownedClients: [{ id: "owned", appCount: 3 }],
      clientMemberships: [{ id: "member", role: "admin", appCount: 2 }],
      appMemberships: [{ id: "site", role: "collaborator", clientName: "Member client" }]
    });
    expect(result.invites[0]).toMatchObject({ inviteType: "site", site: { name: "App" } });
    expect(result.counts).toEqual({ super_admin: 1, admin: 2, collaborator: 0 });
  });

  it("labels billing authority only for super admins; technical admins and grants do not escalate", async () => {
    mocks.users.mockResolvedValue([
      { id: "sa", email: "sa@example.test", fullName: null, role: "super_admin", createdAt: new Date(), platformAdminGrant: null, organizations: [], collaborations: [], siteCollaborations: [] },
      { id: "admin", email: "admin@example.test", fullName: null, role: "admin", createdAt: new Date(), platformAdminGrant: null, organizations: [], collaborations: [], siteCollaborations: [] },
      { id: "grant", email: "grant@example.test", fullName: null, role: "collaborator", createdAt: new Date(), platformAdminGrant: { id: "g" }, organizations: [], collaborations: [], siteCollaborations: [] }
    ]);
    const result = await getAccessDirectory("super-id");
    expect(result.users.map((row: { platformAccess: boolean; platformAccessSources: string[] }) => [row.platformAccess, row.platformAccessSources])).toEqual([
      [true, ["super admin"]], [true, ["global admin"]], [true, ["platform admin grant"]]
    ]);
    expect(result.users[0].role).toBe("super_admin");
    expect(result.users[1].role).toBe("admin");
  });

  it("bounds search and pagination and never selects credentials, financial data or invitation secrets", async () => {
    await getAccessDirectory("super-id", { q: " x ".repeat(100), page: 99_999, invitePage: 0, role: "super_admin" });
    const userQuery = mocks.users.mock.calls[0][0];
    const inviteQuery = mocks.invites.mock.calls[0][0];
    expect(userQuery.skip).toBe(0);
    expect(userQuery.where.role).toBe("super_admin");
    expect(userQuery.where.OR[0].email.contains).toHaveLength(200);
    expect(userQuery.select).not.toHaveProperty("passwordHash");
    expect(userQuery.select).not.toHaveProperty("stripeCustomerId");
    expect(userQuery.select).not.toHaveProperty("subscriptionStatus");
    expect(userQuery.select.platformAdminGrant.select).toEqual({ id: true });
    expect(inviteQuery.skip).toBe(0);
    expect(inviteQuery.select).not.toHaveProperty("tokenHash");
    expect(inviteQuery.select).not.toHaveProperty("deliveryError");
    expect(inviteQuery.select).not.toHaveProperty("inviteUrl");
  });

  it("reports platform technical access for the configured bootstrap user only", async () => {
    vi.stubEnv("BOOTSTRAP_ADMIN_EMAIL", "seed@example.test");
    mocks.users.mockResolvedValue([
      { id: "seed", email: " Seed@Example.Test ", fullName: null, role: "collaborator", createdAt: new Date(), platformAdminGrant: null, organizations: [], collaborations: [], siteCollaborations: [] }
    ]);
    const result = await getAccessDirectory("super-id");
    expect(result.users[0]).toMatchObject({ platformAccess: true, platformAccessSources: ["bootstrap admin"] });
    vi.unstubAllEnvs();
  });
});
