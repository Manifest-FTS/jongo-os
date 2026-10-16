import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ auth: vi.fn(), getDb: vi.fn(), user: vi.fn(), grant: vi.fn(), visible: vi.fn(), orgFind: vi.fn(), orgList: vi.fn(), orgUpdate: vi.fn(), domainFind: vi.fn(), domainList: vi.fn(), domainUpdate: vi.fn(), audit: vi.fn(), transaction: vi.fn() }));
vi.mock("@/lib/auth.config", () => ({ auth: m.auth }));
vi.mock("@/lib/db", () => ({ getDb: m.getDb }));
vi.mock("@/lib/domain-orders", () => ({ getVisibleOrganizationIds: m.visible }));

import { GET as billingGet, PATCH as billingPatch } from "../app/api/client-billing/[clientId]/route";
import { GET as billingList } from "../app/api/client-billing/route";
import { GET as domainsGet, PATCH as domainsPatch } from "../app/api/managed-domains/route";
import { GET as clientsGet } from "../app/api/managed-domains/clients/route";
import ClientBillingPage from "../app/(platform)/client-billing/page";
import ManagedDomainsPage from "../app/(platform)/managed-domains/page";

const clientId = "10000000-0000-0000-0000-000000000001";
const otherId = "10000000-0000-0000-0000-000000000002";
const domainId = "20000000-0000-0000-0000-000000000001";
const context = { params: Promise.resolve({ clientId }) };
const baseClient = { id: clientId, name: "Client A", billingMode: "manual_override", billingStatus: "past_due", billingNotes: "PRIVATE", bonsaiClientId: "b_1", externalInvoiceUrl: "https://invoice.test/1", stripeCustomerId: "SECRET" };
let state: { client: typeof baseClient; domains: Array<Record<string, any>>; audits: unknown[] };

/* eslint-disable @typescript-eslint/no-explicit-any */
function request(body?: unknown, query = "") {
  return new Request(`https://example.test/api/managed-domains${query ? `?${query}` : ""}`, {
    method: body === undefined ? "GET" : "PATCH",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  state = {
    client: { ...baseClient }, audits: [],
    domains: [clientId, otherId, null].map((organizationId, i) => ({
      id: i === 0 ? domainId : `20000000-0000-0000-0000-00000000000${i + 1}`,
      name: `domain${i}.test`, organizationId, organization: organizationId ? { ...baseClient, id: organizationId } : null,
      status: "active", registrar: "namecheap", expiresAt: null, autoRenew: true, dnsStatus: "active", nameservers: [],
      cloudflareZoneId: null, registrarSyncedAt: null, isBillable: true, billingOverride: false, eppCode: "SECRET"
    }))
  };
  m.auth.mockResolvedValue({ user: { id: "user", role: "super_admin", email: "stale@example.test" } });
  m.user.mockResolvedValue({ id: "user", role: "super_admin", email: "super@example.test", deletedAt: null });
  m.grant.mockResolvedValue({ id: "technical-grant" });
  m.visible.mockImplementation(async (_user: string, admin: boolean) => admin ? null : [clientId]);
  m.orgFind.mockImplementation(async ({ where }: any) => where.id === clientId ? state.client : where.id === otherId ? { ...baseClient, id: otherId, name: "Client B" } : null);
  m.orgList.mockResolvedValue([{ ...baseClient }]);
  m.orgUpdate.mockImplementation(async ({ data }: any) => { Object.assign(state.client, data); return { ...state.client }; });
  m.domainFind.mockImplementation(async ({ where }: any) => state.domains.find((domain) => domain.id === where.id) ?? null);
  m.domainList.mockImplementation(async ({ where }: any) => state.domains.filter((domain) => {
    if (!("organizationId" in where)) return true;
    if (where.organizationId === null) return domain.organizationId === null;
    if (typeof where.organizationId === "string") return domain.organizationId === where.organizationId;
    if (where.organizationId.in) return where.organizationId.in.includes(domain.organizationId);
    return domain.organizationId !== null;
  }));
  m.domainUpdate.mockImplementation(async ({ where, data }: any) => { const row = state.domains.find((domain) => domain.id === where.id)!; Object.assign(row, data); return { id: row.id }; });
  m.audit.mockImplementation(async ({ data }: any) => { state.audits.push(data); return data; });
  const db = { user: { findUnique: m.user }, platformAdmin: { findUnique: m.grant }, organization: { findFirst: m.orgFind, findMany: m.orgList, update: m.orgUpdate }, domain: { findFirst: m.domainFind, findMany: m.domainList, update: m.domainUpdate }, auditLog: { create: m.audit }, $transaction: m.transaction };
  m.transaction.mockImplementation(async (callback: (tx: typeof db) => Promise<unknown>) => {
    const snapshot = structuredClone(state);
    try { return await callback(db); } catch (error) { state = snapshot; throw error; }
  });
  m.getDb.mockResolvedValue(db);
});

const financialRoutes = [
  () => billingGet(request(), context),
  () => billingPatch(request({ billingStatus: "active_paid" }), context),
  () => billingList(request()),
  () => clientsGet(request()),
  () => domainsPatch(request({ domainId, organizationId: otherId, isBillable: false }))
];

describe("new financial API authorization", () => {
  it("denies anonymous calls before any DB work", async () => {
    m.auth.mockResolvedValue(null);
    for (const route of [...financialRoutes, () => domainsGet(request())]) {
      const response = await route();
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(m.getDb).not.toHaveBeenCalled();
  });

  it.each(["admin", "collaborator"])("denies fresh %s despite stale super session and technical platform grant", async (role) => {
    m.user.mockResolvedValue({ id: "user", role, email: "seed@example.test", deletedAt: null });
    for (const route of financialRoutes) {
      const response = await route();
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(JSON.stringify(await response.json())).not.toMatch(/PRIVATE|SECRET/);
    }
    for (const spy of [m.orgFind, m.orgList, m.domainFind, m.domainList, m.transaction]) expect(spy).not.toHaveBeenCalled();
  });

  it("fails closed for deleted/missing DB identity and unavailable DB", async () => {
    for (const identity of [null, { id: "user", role: "super_admin", deletedAt: new Date() }]) {
      m.user.mockResolvedValue(identity);
      for (const route of [...financialRoutes, () => domainsGet(request())]) expect((await route()).status).toBe(403);
    }
    m.getDb.mockResolvedValue(null);
    for (const route of financialRoutes) expect((await route()).status).toBe(403);
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("checks authorization before parsing invalid or oversized bodies", async () => {
    m.user.mockResolvedValue({ id: "user", role: "admin", email: "admin@test", deletedAt: null });
    const invalid = () => new Request("https://example.test", { method: "PATCH", body: "NOT JSON", headers: { "Content-Type": "application/json", "Content-Length": "99999999" } });
    expect((await billingPatch(invalid(), context)).status).toBe(403);
    expect((await domainsPatch(invalid())).status).toBe(403);
    expect(m.orgFind).not.toHaveBeenCalled();
  });

  it("explicitly denies admin billing page and unmapped page without querying billing/domain data", async () => {
    m.user.mockResolvedValue({ id: "user", role: "admin", email: "admin@test", deletedAt: null });
    expect(JSON.stringify(await ClientBillingPage({ searchParams: Promise.resolve({}) }))).toContain("Access denied");
    expect(JSON.stringify(await ManagedDomainsPage({ searchParams: Promise.resolve({ assignment: "unassigned" }) }))).toContain("Access denied");
    expect(m.orgFind).not.toHaveBeenCalled();
    expect(m.domainList).not.toHaveBeenCalled();
  });
});

describe("client billing GET/PATCH", () => {
  it("returns only client DTO and persisted manual status, never account Stripe fields", async () => {
    const response = await billingGet(request(), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload = await response.json();
    expect(payload.client).toMatchObject({ id: clientId, billingStatus: "past_due", billingNotes: "PRIVATE" });
    expect(JSON.stringify(payload)).not.toContain("SECRET");
    expect(m.orgFind).toHaveBeenCalledWith(expect.objectContaining({ where: { id: clientId, deletedAt: null } }));
  });

  it("validates IDs, missing clients, query bounds and avoids unbounded queries", async () => {
    expect((await billingGet(request(), { params: Promise.resolve({ clientId: "bad" }) })).status).toBe(400);
    expect(m.orgFind).not.toHaveBeenCalled();
    m.orgFind.mockResolvedValue(null);
    expect((await billingGet(request(), context)).status).toBe(404);
    for (const route of [billingList, clientsGet]) {
      expect((await route(request(undefined, "pageSize=101"))).status).toBe(400);
    }
    expect(m.orgList).not.toHaveBeenCalled();
    expect((await billingList(request(undefined, "page=2&pageSize=10"))).status).toBe(200);
    expect(m.orgList).toHaveBeenCalledWith(expect.objectContaining({ skip: 10, take: 11, where: { deletedAt: null } }));
  });

  it("writes allowlisted fields with atomic, redacted audit", async () => {
    const response = await billingPatch(request({ billingStatus: "comped", billingNotes: "SECRET NEW NOTE", externalInvoiceUrl: "https://invoice.test/secret-token" }), context);
    expect(response.status).toBe(200);
    expect(state.client.billingStatus).toBe("comped");
    expect(m.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
    expect(state.audits).toEqual([expect.objectContaining({ organizationId: clientId, actorId: "user", action: "client_billing_updated", details: { fields: ["billingStatus", "billingNotes", "externalInvoiceUrl"] } })]);
    expect(JSON.stringify(state.audits)).not.toMatch(/SECRET|secret-token|PRIVATE|b_1/);
  });

  it.each([{ billingNotes: "ok", ownerId: "other" }, { billingStatus: "paid" }, { externalInvoiceUrl: "javascript:alert(1)" }, { billingNotes: "x".repeat(4001) }, { billingMode: "exempt", billingStatus: "comped" }])("rejects invalid updates without mutation %#", async (input) => {
    expect((await billingPatch(request(input), context)).status).toBe(400);
    expect(m.orgUpdate).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
    expect(state.client).toEqual(baseClient);
  });

  it("does not store derived comped on switching to exempt", async () => {
    const response = await billingPatch(request({ billingMode: "exempt" }), context);
    expect((await response.json()).client.billingStatus).toBe("comped");
    expect(state.client.billingStatus).toBe("pending_setup");
  });

  it("rolls back a billing write if the required audit fails, without leaking DB errors", async () => {
    m.audit.mockRejectedValue(new Error("SECRET CONNECTION STRING"));
    const response = await billingPatch(request({ billingStatus: "active_paid" }), context);
    expect(response.status).toBe(503);
    expect(state.client).toEqual(baseClient);
    expect(JSON.stringify(await response.json())).not.toContain("SECRET");
  });
});

describe("managed inventory API isolation", () => {
  it("collaborators get assigned visible clients only and no finances, even if DB overselects", async () => {
    m.user.mockResolvedValue({ id: "user", role: "collaborator", email: "collab@test", deletedAt: null });
    m.grant.mockResolvedValue(null);
    const response = await domainsGet(request());
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(m.visible).toHaveBeenCalledWith("user", false);
    expect(payload.domains.map((domain: any) => domain.id)).toEqual([domainId]);
    expect(JSON.stringify(payload)).not.toMatch(/PRIVATE|SECRET|billingNotes|billingMode|isBillable|billingOverride|financial/);
    expect(m.domainList).toHaveBeenCalledWith(expect.objectContaining({ where: { deletedAt: null, organizationId: { in: [clientId] } } }));
  });

  it("empty collaborator scope exposes neither other clients nor null/unassigned", async () => {
    m.user.mockResolvedValue({ id: "user", role: "collaborator", email: "collab@test", deletedAt: null });
    m.grant.mockResolvedValue(null);
    m.visible.mockResolvedValue([]);
    expect((await (await domainsGet(request())).json()).domains).toEqual([]);
    expect((await domainsGet(request(undefined, "assignment=unassigned"))).status).toBe(403);
  });

  it("global admin gets technical all but not finances, mapper or unmapped view", async () => {
    m.user.mockResolvedValue({ id: "user", role: "admin", email: "admin@test", deletedAt: null });
    const payload = await (await domainsGet(request())).json();
    expect(payload.domains).toHaveLength(3);
    expect(payload.canManageBilling).toBe(false);
    expect(JSON.stringify(payload)).not.toMatch(/PRIVATE|SECRET|financial|billingMode/);
    m.domainList.mockClear(); m.visible.mockClear();
    expect((await domainsGet(request(undefined, "assignment=unassigned"))).status).toBe(403);
    expect(m.domainList).not.toHaveBeenCalled();
    expect(m.visible).not.toHaveBeenCalled();
  });

  it("super gets unmapped inventory and client financial DTOs only on mapped domains", async () => {
    const response = await domainsGet(request(undefined, "assignment=unassigned"));
    const payload = await response.json();
    expect(payload.domains).toHaveLength(1);
    expect(payload.domains[0]).toMatchObject({ organizationId: null, financial: { clientBilling: null } });
    const all = await (await domainsGet(request())).json();
    expect(all.domains[0].financial.clientBilling.billingStatus).toBe("past_due");
    expect(JSON.stringify(all)).not.toContain("SECRET");
  });

  it("bounds inventory pagination before querying and fails closed on invalid scope", async () => {
    expect((await domainsGet(request(undefined, "pageSize=101"))).status).toBe(400);
    expect(m.domainList).not.toHaveBeenCalled();
    m.user.mockResolvedValue({ id: "user", role: "collaborator", email: "collab@test", deletedAt: null });
    m.grant.mockResolvedValue(null); m.visible.mockResolvedValue(null);
    expect((await domainsGet(request())).status).toBe(403);
    expect(m.domainList).not.toHaveBeenCalled();
  });
});

describe("managed domain assignments and flags", () => {
  it("validates active clients before updating and logs both sides of reassignment atomically", async () => {
    const response = await domainsPatch(request({ domainId, organizationId: otherId, isBillable: false, billingOverride: true }));
    expect(response.status).toBe(200);
    expect(m.orgFind).toHaveBeenCalledWith({ where: { id: otherId, deletedAt: null }, select: { id: true } });
    expect(state.domains[0]).toMatchObject({ organizationId: otherId, isBillable: false, billingOverride: true });
    expect(state.audits).toHaveLength(2);
    expect(state.audits).toEqual(expect.arrayContaining([expect.objectContaining({ organizationId: clientId }), expect.objectContaining({ organizationId: otherId })]));
    expect(JSON.stringify(state.audits)).not.toMatch(/SECRET|PRIVATE/);
  });

  it("maps an unassigned domain and updates flags in one transaction", async () => {
    const response = await domainsPatch(request({ domainId: state.domains[2].id, organizationId: clientId, isBillable: true }));
    expect(response.status).toBe(200);
    expect(state.domains[2].organizationId).toBe(clientId);
    expect(state.audits).toHaveLength(1);
  });

  it("rejects missing/deleted clients and missing domains without mutations", async () => {
    m.orgFind.mockResolvedValue(null);
    expect((await domainsPatch(request({ domainId, organizationId: otherId }))).status).toBe(400);
    m.domainFind.mockResolvedValue(null);
    expect((await domainsPatch(request({ domainId, organizationId: otherId }))).status).toBe(404);
    expect(m.domainUpdate).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("rejects billing flags on unassigned domains; supports audited unassigning without flags", async () => {
    expect((await domainsPatch(request({ domainId: state.domains[2].id, isBillable: true }))).status).toBe(409);
    expect(m.domainUpdate).not.toHaveBeenCalled();
    expect((await domainsPatch(request({ domainId, organizationId: null }))).status).toBe(200);
    expect(state.domains[0].organizationId).toBeNull();
    expect(state.audits).toHaveLength(1);
  });

  it.each([{ domainId, autoRenew: false }, { domainId, isBillable: "true" }, { domainId, organizationId: "bad" }, { domainId, billingNotes: "no" }])("rejects unowned technical or invalid fields %#", async (input) => {
    expect((await domainsPatch(request(input))).status).toBe(400);
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("rolls back domain assignment and earlier audits if the second client audit fails", async () => {
    m.audit.mockImplementationOnce(async ({ data }: any) => { state.audits.push(data); return data; }).mockRejectedValueOnce(new Error("Audit failed"));
    const response = await domainsPatch(request({ domainId, organizationId: otherId }));
    expect(response.status).toBe(503);
    expect(state.domains[0].organizationId).toBe(clientId);
    expect(state.audits).toEqual([]);
  });

  it("client picker is active-only, minimal, searchable and bounded", async () => {
    const response = await clientsGet(request(undefined, "q=Client&pageSize=10"));
    expect(response.status).toBe(200);
    expect((await response.json()).clients).toEqual([{ id: clientId, name: "Client A" }]);
    expect(m.orgList).toHaveBeenCalledWith(expect.objectContaining({ where: { deletedAt: null, name: { contains: "Client", mode: "insensitive" } }, select: { id: true, name: true }, take: 11 }));
  });
});