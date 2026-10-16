import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  getDb: vi.fn(), isSuperAdminUser: vi.fn(), getStripeClient: vi.fn(), validateContact: vi.fn(),
  checkDomain: vi.fn(), getDomainInfo: vi.fn(), getPriceBook: vi.fn(), getTransferPriceList: vi.fn(),
  getTransferStatus: vi.fn(), registerDomain: vi.fn(), renewDomain: vi.fn(), transferDomain: vi.fn(),
  setCustomNameservers: vi.fn(), isInsufficientFunds: vi.fn(),
  applySslDefaults: vi.fn(), ensureZone: vi.fn(), getZone: vi.fn(), isCloudflareConfigured: vi.fn()
}));
vi.mock("@/lib/db", () => ({ getDb: m.getDb }));
vi.mock("@/lib/rbac", () => ({ isSuperAdminUser: m.isSuperAdminUser }));
vi.mock("@/lib/stripe", () => ({ getStripeClient: m.getStripeClient }));
vi.mock("@/lib/domain-contact", () => ({ validateContact: m.validateContact }));
vi.mock("@/lib/namecheap", () => ({
  checkDomain: m.checkDomain, getDomainInfo: m.getDomainInfo, getPriceBook: m.getPriceBook,
  getTransferPriceList: m.getTransferPriceList, getTransferStatus: m.getTransferStatus,
  registerDomain: m.registerDomain, renewDomain: m.renewDomain, transferDomain: m.transferDomain,
  setCustomNameservers: m.setCustomNameservers, isInsufficientFunds: m.isInsufficientFunds,
  NamecheapError: class extends Error {}
}));
vi.mock("@/lib/cloudflare", () => ({
  applySslDefaults: m.applySslDefaults, ensureZone: m.ensureZone, getZone: m.getZone,
  isCloudflareConfigured: m.isCloudflareConfigured
}));

import { fulfilDomainCharge, provisionDomainDns, reconcileDomains, startDomainCheckout, type CheckoutInput } from "./domain-orders";

/* eslint-disable @typescript-eslint/no-explicit-any */
function inventory(overrides: Record<string, unknown> = {}) {
  return {
    id: "inventory", name: "inventory.com", organizationId: null, status: "active", deletedAt: null,
    dnsManagementEnabled: false, cloudflareZoneId: null, dnsStatus: "pending", nameservers: ["ns.external.com"],
    registrar: "namecheap", registrarSyncedAt: new Date(), updatedAt: new Date(),
    isBillable: false, billingOverride: true, lastError: "Existing inventory note", ...overrides
  };
}

// Apply the actual Prisma predicates, rather than returning canned rows for
// each call: removing the enrollment filter must expose inventory to reconcile.
function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([key, value]: [string, any]) => {
    if (key === "OR") return value.some((clause: any) => matches(row, clause));
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if (value.in && !value.in.includes(row[key])) return false;
      if (value.lt && !(row[key] < value.lt)) return false;
      return true;
    }
    return row[key] === value;
  });
}

function database() {
  const rows = new Map<string, any>();
  const db = {
    domain: {
      findUnique: vi.fn(async ({ where }: any) => [...rows.values()].find((row) => matches(row, where)) ?? null),
      findMany: vi.fn(async ({ where, take }: any) => [...rows.values()].filter((row) => matches(row, where)).slice(0, take)),
      create: vi.fn(async ({ data }: any) => {
        const row = inventory({ id: "ordered", ...data });
        rows.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = { ...rows.get(where.id), ...data, updatedAt: new Date() };
        rows.set(row.id, row);
        return row;
      })
    },
    domainCharge: {
      findMany: vi.fn(async () => []), findUnique: vi.fn(), findFirst: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async ({ data }: any) => ({ id: "charge", ...data })), update: vi.fn()
    },
    organization: { findMany: vi.fn(async () => [{ id: "client", name: "Client" }]) },
    user: { findUnique: vi.fn(async () => ({ stripeCustomerId: "cus_existing" })), update: vi.fn() }
  };
  return { db, rows };
}

const providerCalls = [
  m.checkDomain, m.getDomainInfo, m.getPriceBook, m.getTransferPriceList, m.getTransferStatus,
  m.registerDomain, m.renewDomain, m.transferDomain, m.setCustomNameservers,
  m.isCloudflareConfigured, m.ensureZone, m.applySslDefaults, m.getZone
];

describe("domain DNS enrollment", () => {
  let store: ReturnType<typeof database>;
  let checkoutSession: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetAllMocks();
    store = database();
    m.getDb.mockResolvedValue(store.db);
    m.isSuperAdminUser.mockResolvedValue(true);
    m.getTransferPriceList.mockResolvedValue(new Map([["com", {}]]));
    const price = [{ years: 1, priceCents: 1000, additionalCents: 0 }];
    m.getPriceBook.mockResolvedValue({ register: price, renew: price, transfer: price });
    m.checkDomain.mockResolvedValue({ available: true, premium: false });
    m.validateContact.mockReturnValue({ ok: true, contact: { firstName: "Buyer" } });
    m.isCloudflareConfigured.mockReturnValue(true);
    m.ensureZone.mockResolvedValue({ id: "zone", status: "active", name_servers: ["NS1.CLOUDFLARE.COM", "ns2.cloudflare.com"] });
    m.applySslDefaults.mockResolvedValue(undefined);
    m.setCustomNameservers.mockResolvedValue(undefined);
    m.getZone.mockResolvedValue({ id: "zone", status: "active" });
    checkoutSession = vi.fn().mockResolvedValue({ id: "cs_checkout", url: "https://checkout.example.test" });
    m.getStripeClient.mockReturnValue({ checkout: { sessions: { create: checkoutSession } } });
  });

  it.each([
    { organizationId: null, dnsManagementEnabled: false },
    { organizationId: "client", dnsManagementEnabled: false },
    { organizationId: "client", dnsManagementEnabled: undefined },
    { organizationId: "client", dnsManagementEnabled: false, cloudflareZoneId: "mapped-zone", dnsStatus: "error" }
  ])("direct provisioning leaves unenrolled inventory untouched: %j", async (fields) => {
    const row = inventory(fields);
    store.rows.set(row.id, row);
    // Neither configured DNS nor the unconfigured pending/error path may run.
    for (const configured of [true, false]) {
      m.isCloudflareConfigured.mockReturnValue(configured);
      await provisionDomainDns(row.id);
    }
    expect(store.rows.get(row.id)).toEqual(row);
    expect(store.db.domain.update).not.toHaveBeenCalled();
    for (const call of providerCalls) expect(call).not.toHaveBeenCalled();
  });

  it.each(["pending", "error", "active"])("actual reconcile ignores mapped and unassigned imported inventory with DNS %s", async (dnsStatus) => {
    const rows = [
      inventory({ dnsStatus }),
      inventory({ id: "assigned", name: "assigned.com", organizationId: "client", dnsStatus }),
      inventory({ id: "mapped", name: "mapped.com", organizationId: "client", cloudflareZoneId: "mapped-zone", dnsStatus })
    ];
    for (const row of rows) store.rows.set(row.id, row);
    expect(await reconcileDomains()).toEqual({ retried: 0, recovered: 0, transfersCompleted: 0,
      transfersFailed: 0, dnsProvisioned: 0, expiriesRefreshed: 0, checkoutsExpired: 0 });
    expect([...store.rows.values()]).toEqual(rows);
    expect(store.db.domain.update).not.toHaveBeenCalled();
    expect(store.db.domain.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: "active", deletedAt: null, dnsManagementEnabled: true })
    }));
    for (const call of providerCalls) expect(call).not.toHaveBeenCalled();
    expect(m.getStripeClient).not.toHaveBeenCalled();
    expect(store.db.domainCharge.create).not.toHaveBeenCalled();
  });

  it("actual reconcile provisions enrolled active orders alongside untouched imported inventory", async () => {
    const imported = inventory();
    const enrolled = inventory({ id: "enrolled", name: "ordered.com", organizationId: "client", dnsManagementEnabled: true });
    store.rows.set(imported.id, imported);
    store.rows.set(enrolled.id, enrolled);
    expect(await reconcileDomains()).toMatchObject({ dnsProvisioned: 1 });
    expect(m.ensureZone.mock.calls).toEqual([[enrolled.name]]);
    expect(m.applySslDefaults).toHaveBeenCalledWith("zone");
    expect(m.setCustomNameservers).toHaveBeenCalledWith(expect.objectContaining({ domain: enrolled.name }),
      ["ns1.cloudflare.com", "ns2.cloudflare.com"]);
    expect(store.rows.get(enrolled.id)).toMatchObject({ dnsManagementEnabled: true, cloudflareZoneId: "zone", dnsStatus: "active", lastError: null });
    expect(store.rows.get(imported.id)).toEqual(imported);
    expect(store.db.domain.update).toHaveBeenCalledTimes(1);
    expect(store.db.domain.update.mock.calls[0][0].where).toEqual({ id: enrolled.id });
    expect(m.registerDomain).not.toHaveBeenCalled();
    expect(m.transferDomain).not.toHaveBeenCalled();
    expect(m.renewDomain).not.toHaveBeenCalled();
  });

  it("actual reconcile polls only enrolled mapped zones", async () => {
    const imported = inventory({ cloudflareZoneId: "inventory-zone", organizationId: "client" });
    const enrolled = inventory({ id: "enrolled", dnsManagementEnabled: true, cloudflareZoneId: "zone" });
    store.rows.set(imported.id, imported);
    store.rows.set(enrolled.id, enrolled);
    expect(await reconcileDomains()).toMatchObject({ dnsProvisioned: 0 });
    expect(m.getZone.mock.calls).toEqual([["zone"]]);
    expect(m.ensureZone).not.toHaveBeenCalled();
    expect(m.setCustomNameservers).not.toHaveBeenCalled();
    expect(store.rows.get(enrolled.id).dnsStatus).toBe("active");
    expect(store.rows.get(imported.id)).toEqual(imported);
  });

  it.each([
    { status: "pending_payment" }, { status: "expired" }, { deletedAt: new Date() }
  ])("direct provisioning retains active/nondeleted guards: %j", async (fields) => {
    const row = inventory({ dnsManagementEnabled: true, ...fields });
    store.rows.set(row.id, row);
    await provisionDomainDns(row.id);
    expect(store.db.domain.update).not.toHaveBeenCalled();
    for (const call of providerCalls) expect(call).not.toHaveBeenCalled();
  });

  const input: CheckoutInput = {
    userId: "buyer", userEmail: "buyer@example.com", isPlatformAdmin: true,
    organizationId: "client", domain: "ordered.com", operation: "register", years: 1,
    contact: {}, eppCode: "valid-epp", origin: "https://app.example.test"
  };

  it.each(["register", "transfer"] as const)("new %s checkout explicitly enrolls DNS without placing an order", async (operation) => {
    m.checkDomain.mockResolvedValue({ available: operation === "register", premium: false });
    expect(await startDomainCheckout({ ...input, operation })).toMatchObject({ ok: true });
    expect(store.db.domain.create).toHaveBeenCalledWith({ data: expect.objectContaining({ dnsManagementEnabled: true, status: "pending_payment" }) });
    expect(checkoutSession).toHaveBeenCalledOnce();
    expect(m.registerDomain).not.toHaveBeenCalled();
    expect(m.transferDomain).not.toHaveBeenCalled();
    expect(m.ensureZone).not.toHaveBeenCalled();
    expect(m.setCustomNameservers).not.toHaveBeenCalled();
  });

  it.each(["register", "transfer"] as const)("retryable existing %s checkout explicitly enrolls DNS", async (operation) => {
    const row = inventory({ name: input.domain, organizationId: "client", status: "failed" });
    store.rows.set(row.id, row);
    m.checkDomain.mockResolvedValue({ available: operation === "register", premium: false });
    expect(await startDomainCheckout({ ...input, operation })).toMatchObject({ ok: true });
    expect(store.rows.get(row.id)).toMatchObject({ dnsManagementEnabled: true, status: "pending_payment", isBillable: false, billingOverride: true });
  });

  it.each([false, true])("renewal checkout preserves DNS enrollment %s", async (dnsManagementEnabled) => {
    const row = inventory({ name: input.domain, organizationId: "client", dnsManagementEnabled });
    store.rows.set(row.id, row);
    expect(await startDomainCheckout({ ...input, operation: "renew" })).toMatchObject({ ok: true });
    expect(store.rows.get(row.id)).toEqual(row);
    expect(store.db.domain.update).not.toHaveBeenCalled();
    expect(store.db.domain.create).not.toHaveBeenCalled();
    expect(store.db.domainCharge.create).toHaveBeenCalledWith({ data: expect.objectContaining({ operation: "renew", domainId: row.id }) });
    expect(m.ensureZone).not.toHaveBeenCalled();
    expect(m.setCustomNameservers).not.toHaveBeenCalled();
  });

  it("unauthorized checkout cannot enroll inventory", async () => {
    m.isSuperAdminUser.mockResolvedValue(false);
    expect(await startDomainCheckout(input)).toMatchObject({ ok: false, status: 403 });
    expect(m.getDb).not.toHaveBeenCalled();
    expect(store.db.domain.create).not.toHaveBeenCalled();
    expect(store.db.domain.update).not.toHaveBeenCalled();
    expect(checkoutSession).not.toHaveBeenCalled();
  });

  it("an unpaid or already claimed charge cannot place an order or enable DNS", async () => {
    await fulfilDomainCharge("unpaid");
    expect(store.db.domainCharge.updateMany).toHaveBeenCalledWith({
      where: { id: "unpaid", status: "paid" }, data: { status: "fulfilling" }
    });
    expect(store.db.domain.update).not.toHaveBeenCalled();
    for (const call of providerCalls) expect(call).not.toHaveBeenCalled();
  });
});