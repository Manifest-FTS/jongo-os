import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ getDb: vi.fn(), user: vi.fn(), organizations: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: m.getDb }));
import { listWorkspaceOptions, WorkspaceAuthenticationError, WorkspaceQueryError } from "./workspace-switcher";

type Row = Record<string, any>;
// Evaluate the actual Prisma-shaped scope, not a mock that always returns an allowed row.
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "AND") return value.every((part: Row) => matches(row, part));
    if (key === "OR") return value.some((part: Row) => matches(row, part));
    if (value && typeof value === "object") {
      if ("some" in value) return (row[key] ?? []).some((child: Row) => matches(child, value.some));
      if ("contains" in value) return String(row[key]).toLowerCase().includes(value.contains.toLowerCase());
      if ("gt" in value) return row[key] > value.gt;
      return !!row[key] && matches(row[key], value);
    }
    return row[key] === value;
  });
}
function project(row: Row, select: Row): Row {
  return Object.fromEntries(Object.entries(select).map(([key, value]) =>
    [key, value === true ? row[key] : row[key] ? project(row[key], value.select) : null]));
}
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function org(n: number, overrides: Row = {}): Row {
  return {
    id: id(n), name: `Workspace ${String(n).padStart(3, "0")}`, slug: `workspace-${n}`, deletedAt: null,
    ownerId: "actor", owner: {
      deletedAt: null, subscriptionPlanId: "core-sla", subscriptionStatus: "active",
      subscriptionCurrentPeriodEnd: new Date("2099-01-01"), stripeCustomerId: "private-customer",
      stripeSubscriptionId: "private-subscription", email: "private@example.test"
    },
    collaborators: [], sites: [], billingNotes: "private finance", ...overrides
  };
}
let rows: Row[];
beforeEach(() => {
  vi.resetAllMocks();
  rows = [org(1)];
  m.getDb.mockResolvedValue({ user: { findFirst: m.user }, organization: { findMany: m.organizations } });
  m.user.mockResolvedValue({ id: "actor" });
  m.organizations.mockImplementation(async ({ where, select, take, orderBy }) => {
    expect(orderBy).toEqual([{ name: "asc" }, { id: "asc" }]);
    return rows.filter((row) => matches(row, where)).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1
    ).slice(0, take).map((row) => project(row, select));
  });
});

describe("fresh tenant workspace scope", () => {
  it("returns ownership and active org membership only, never global or site-only access", async () => {
    rows.push(
      org(2, { ownerId: "other", collaborators: [{ userId: "actor", deletedAt: null, user: { deletedAt: null } }] }),
      org(3, { ownerId: "other", collaborators: [{ userId: "actor", deletedAt: new Date(), user: { deletedAt: null } }] }),
      org(4, { ownerId: "other", sites: [{ collaborators: [{ userId: "actor", deletedAt: null }] }] }),
      org(5, { ownerId: "other", platformAdmin: true }),
      org(6, { deletedAt: new Date() }),
      org(7, { ownerId: "other", collaborators: [{ userId: "someone-else", deletedAt: null, user: { deletedAt: null } }] })
    );
    expect((await listWorkspaceOptions("actor")).items.map((item) => item.id)).toEqual([id(1), id(2)]);
    expect(m.user).toHaveBeenCalledWith({ where: { id: "actor", deletedAt: null }, select: { id: true } });
    const query = JSON.stringify(m.organizations.mock.calls[0][0]);
    expect(query).not.toMatch(/platformAdmin|GlobalRole|siteCollaborations|sites|email/);
  });
  it("reads membership again after revocation/deletion, never caches prior scope", async () => {
    rows = [org(2, { ownerId: "other", collaborators: [{ userId: "actor", deletedAt: null, user: { deletedAt: null } }] })];
    expect((await listWorkspaceOptions("actor")).items).toHaveLength(1);
    rows[0].collaborators[0].deletedAt = new Date();
    expect((await listWorkspaceOptions("actor")).items).toEqual([]);
    rows[0].collaborators = [];
    expect((await listWorkspaceOptions("actor")).items).toEqual([]);
    expect(m.user).toHaveBeenCalledTimes(3);
  });
  it("rejects missing/deleted actors and does not query organizations", async () => {
    await expect(listWorkspaceOptions("")).rejects.toBeInstanceOf(WorkspaceAuthenticationError);
    m.user.mockResolvedValue(null);
    await expect(listWorkspaceOptions("actor")).rejects.toBeInstanceOf(WorkspaceAuthenticationError);
    expect(m.organizations).not.toHaveBeenCalled();
  });
  it("excludes deleted ownership principals and deleted membership principals", async () => {
    rows[0].owner.deletedAt = new Date();
    rows.push(org(2, { ownerId: "other", collaborators: [{ userId: "actor", deletedAt: null, user: { deletedAt: new Date() } }] }));
    expect((await listWorkspaceOptions("actor")).items).toEqual([]);
  });
  it("fails closed on database outage without mock workspaces", async () => {
    m.getDb.mockResolvedValue(null);
    await expect(listWorkspaceOptions("actor")).rejects.toThrow("unavailable");
    m.getDb.mockRejectedValue(new Error("private db detail"));
    await expect(listWorkspaceOptions("actor")).rejects.toThrow();
  });
});

describe("minimal truthful plan projection", () => {
  it.each([
    ["starter", "Starter"], ["pro", "Pro"], ["core-sla", "Studio"], ["enterprise-sla", "Scale"],
    ["unknown", null], [null, null], ["studio", null]
  ])("maps persisted %s to display %s only", async (plan, label) => {
    rows[0].owner.subscriptionPlanId = plan;
    const result = await listWorkspaceOptions("actor");
    expect(result.items).toEqual([{ id: id(1), name: "Workspace 001", slug: "workspace-1", planLabel: label }]);
    expect(Object.keys(result.items[0]).sort()).toEqual(["id", "name", "planLabel", "slug"]);
    expect(JSON.stringify(result)).not.toMatch(/stripe|subscription|owner|billing|private|2099/);
    expect(m.organizations.mock.calls[0][0].select).toEqual({
      id: true, name: true, slug: true, owner: { select: {
        deletedAt: true, subscriptionPlanId: true, subscriptionStatus: true, subscriptionCurrentPeriodEnd: true
      } }
    });
  });
  it.each(["past_due", "unpaid", "canceled", "trialing", "incomplete", null])("does not label inactive %s as Studio", async (status) => {
    rows[0].owner.subscriptionStatus = status;
    expect((await listWorkspaceOptions("actor")).items[0].planLabel).toBeNull();
  });
  it.each([new Date("2000-01-01"), new Date(NaN), null])("does not label expired/missing/invalid owner periods", async (period) => {
    rows[0].owner.subscriptionCurrentPeriodEnd = period;
    expect((await listWorkspaceOptions("actor")).items[0].planLabel).toBeNull();
  });
  it("keeps collaborator scope but omits a deleted owner's tier", async () => {
    rows[0].ownerId = "other";
    rows[0].collaborators = [{ userId: "actor", deletedAt: null, user: { deletedAt: null } }];
    rows[0].owner.deletedAt = new Date();
    expect((await listWorkspaceOptions("actor")).items[0].planLabel).toBeNull();
  });
});

describe("bounded remote search and stable name/id keysets", () => {
  it("uses a bounded lookahead and paginates duplicate names without duplicates", async () => {
    rows = Array.from({ length: 205 }, (_, index) => org(index + 1, { name: "Same name" }));
    const first = await listWorkspaceOptions("actor");
    expect(first.items).toHaveLength(100);
    expect(first.hasMore).toBe(true);
    expect(m.organizations.mock.calls[0][0].take).toBe(101);
    const second = await listWorkspaceOptions("actor", { cursor: first.nextCursor });
    const third = await listWorkspaceOptions("actor", { cursor: second.nextCursor });
    expect(second.items).toHaveLength(100);
    expect(third.items).toHaveLength(5);
    expect(third).toMatchObject({ hasMore: false, nextCursor: null });
    expect(new Set([...first.items, ...second.items, ...third.items].map((item) => item.id)).size).toBe(205);
  });
  it("searches beyond the initial 100, by case-insensitive name or slug within tenant scope", async () => {
    rows = Array.from({ length: 130 }, (_, index) => org(index + 1));
    rows.push(org(200, { ownerId: "other", name: "Workspace 130" }));
    expect((await listWorkspaceOptions("actor", { search: "  WORKSPACE 130  " })).items.map((item) => item.id)).toEqual([id(130)]);
    expect((await listWorkspaceOptions("actor", { search: "workspace-130" })).items.map((item) => item.id)).toEqual([id(130)]);
  });
  it("cursors need not refer to a still-existing row and never grant scope", async () => {
    rows = [org(1), org(2), org(3)];
    const first = await listWorkspaceOptions("actor", { limit: 1 });
    rows.shift();
    rows[0].ownerId = "other";
    expect((await listWorkspaceOptions("actor", { cursor: first.nextCursor })).items.map((item) => item.id)).toEqual([id(3)]);
  });
  it.each([{ search: "a".repeat(101) }, { limit: 101 }, { limit: 0 }, { limit: 1.5 }, { limit: NaN },
    { cursor: "" }, { cursor: "bad!" }, { cursor: "a".repeat(8193) }])("rejects invalid input before DB access: %j", async (query) => {
    await expect(listWorkspaceOptions("actor", query)).rejects.toBeInstanceOf(WorkspaceQueryError);
    expect(m.getDb).not.toHaveBeenCalled();
  });
  it("binds cursor to its search and rejects invalid cursor IDs", async () => {
    rows = [org(1), org(2)];
    const first = await listWorkspaceOptions("actor", { limit: 1 });
    await expect(listWorkspaceOptions("actor", { search: "new", cursor: first.nextCursor })).rejects.toBeInstanceOf(WorkspaceQueryError);
    const cursor = Buffer.from(JSON.stringify({ name: "x", id: "not-uuid", search: "" })).toString("base64url");
    await expect(listWorkspaceOptions("actor", { cursor })).rejects.toBeInstanceOf(WorkspaceQueryError);
  });
});