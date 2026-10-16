import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), page: vi.fn(), mode: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/namecheap", () => ({ getDomainListPage: mocks.page, namecheapMode: mocks.mode }));
import { syncNamecheapDomains } from "./domain-sync";

/* eslint-disable @typescript-eslint/no-explicit-any */
function domain(name = "example.com", expired = false) {
  return { domain: name, domainId: "123", expiresAt: new Date("2027-01-07T00:00:00Z"), autoRenew: true, expired };
}
function batch(domains = [domain()], currentPage = 1, totalItems = domains.length) {
  return { domains, currentPage, totalItems, pageSize: 100 };
}

/** Serialized short transactions with rollback, not a process-local sync lock. */
function database() {
  const rows = new Map<string, any>();
  let lease: any = null;
  let now = new Date("2026-10-16T00:00:00Z");
  let queue = Promise.resolve();
  let inTransaction = false;
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => [{ now }]),
    webhookEvent: {
      findUnique: vi.fn(async () => lease),
      upsert: vi.fn(async ({ create, update }: any) => { lease = lease ? { ...lease, ...update } : create; return lease; }),
      update: vi.fn(async ({ data }: any) => { lease = { ...lease, ...data }; return lease; }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (lease?.detail !== where.detail || lease?.outcome !== where.outcome) return { count: 0 };
        lease = { ...lease, ...data }; return { count: 1 };
      })
    },
    domain: {
      createMany: vi.fn(async ({ data }: any) => {
        const row = data[0];
        if (rows.has(row.name)) return { count: 0 };
        rows.set(row.name, { isBillable: true, billingOverride: false, ...row }); return { count: 1 };
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = rows.get(where.name);
        if (!row || row.registrar !== where.registrar || row.deletedAt) return { count: 0 };
        rows.set(row.name, { ...row, ...data }); return { count: 1 };
      })
    }
  };
  const db = { ...tx, $transaction: vi.fn(async (fn: any) => {
    const previous = queue;
    let release!: () => void;
    queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const savedLease = lease && { ...lease };
    const savedRows = new Map(rows);
    inTransaction = true;
    try { return await fn(tx); }
    catch (error) { lease = savedLease; rows.clear(); for (const [key, row] of savedRows) rows.set(key, row); throw error; }
    finally { inTransaction = false; release(); }
  }) };
  return { db, rows, tx, get lease() { return lease; }, set lease(value) { lease = value; },
    set now(value: Date) { now = value; }, get inTransaction() { return inTransaction; } };
}

describe("Namecheap domain synchronization", () => {
  let store: ReturnType<typeof database>;
  beforeEach(() => {
    vi.clearAllMocks();
    store = database();
    mocks.getDb.mockResolvedValue(store.db);
    mocks.mode.mockReturnValue("live");
    mocks.page.mockReset().mockImplementation(async () => {
      expect(store.inTransaction).toBe(false);
      return batch();
    });
  });

  it("imports active/expired inventory unassigned, without billing or order side effects", async () => {
    mocks.page.mockResolvedValue(batch([domain(), domain("expired.com", true)]));
    expect(await syncNamecheapDomains()).toMatchObject({ ok: true, imported: 2, updated: 0, fetched: 2, errors: [] });
    expect(store.rows.get("example.com")).toMatchObject({ organizationId: null, status: "active", registrar: "namecheap", autoRenew: true, isBillable: true, billingOverride: false });
    expect(store.rows.get("expired.com").status).toBe("expired");
    expect(store.lease).toMatchObject({ source: "namecheap-domain-sync", outcome: "applied", detail: null });
    expect(store.tx.$executeRaw.mock.calls.every(([sql]: any) => sql.join("").includes("pg_advisory_xact_lock"))).toBe(true);
  });

  it.each(["active", "expired", "pending_payment", "registering", "transfer_pending", "failed"])("preserves assignment, billing and existing %s order state", async (status) => {
    const original = { name: "example.com", organizationId: "client-id", registrar: "namecheap", status,
      isBillable: false, billingOverride: true, transferId: "transfer", cloudflareZoneId: "zone", nameservers: ["ns.client.com"],
      dnsStatus: "active", lastError: "Order awaiting confirmation", createdById: "buyer" };
    store.rows.set(original.name, original);
    expect(await syncNamecheapDomains()).toMatchObject({ ok: true, imported: 0, updated: 1 });
    expect(store.rows.get(original.name)).toMatchObject({ ...original, autoRenew: true, registrarDomainId: "123" });
    expect(Object.keys(store.tx.domain.updateMany.mock.calls[0][0].data).sort()).toEqual(["autoRenew", "expiresAt", "registrarDomainId", "registrarSyncedAt"]);
  });

  it("does not delete missing inventory, restore soft deletions or hijack other registrars", async () => {
    const missing = { name: "missing.com", status: "active" };
    store.rows.set(missing.name, missing);
    store.rows.set("example.com", { name: "example.com", registrar: "other", status: "active" });
    store.rows.set("deleted.com", { name: "deleted.com", registrar: "namecheap", deletedAt: new Date() });
    mocks.page.mockResolvedValue(batch([domain(), domain("deleted.com")]));
    expect(await syncNamecheapDomains()).toMatchObject({ ok: true, skipped: 2, imported: 0, updated: 0 });
    expect(store.rows.get(missing.name)).toEqual(missing);
    expect(store.rows.get("deleted.com").deletedAt).toBeInstanceOf(Date);
  });

  it("survives a checkout insert race without overwriting its order or owner", async () => {
    const originalCreate = store.tx.domain.createMany.getMockImplementation()!;
    store.tx.domain.createMany.mockImplementationOnce(async (args: any) => {
      store.rows.set("example.com", { name: "example.com", registrar: "namecheap", organizationId: "concurrent-buyer", status: "registering", billingOverride: true, isBillable: false });
      return originalCreate(args);
    });
    expect(await syncNamecheapDomains()).toMatchObject({ ok: true, imported: 0, updated: 1 });
    expect(store.rows.get("example.com")).toMatchObject({ organizationId: "concurrent-buyer", status: "registering", billingOverride: true, isBillable: false });
  });

  it("paginates a full page followed by a short final page", async () => {
    const first = Array.from({ length: 100 }, (_, i) => domain(`domain-${i}.com`));
    mocks.page.mockResolvedValueOnce(batch(first, 1, 101)).mockResolvedValueOnce(batch([domain()], 2, 101));
    expect(await syncNamecheapDomains()).toMatchObject({ ok: true, pages: 2, fetched: 101, imported: 101 });
    expect(mocks.page.mock.calls).toEqual([[1, 100], [2, 100]]);
  });

  it("excludes a second sync in the database while the first is awaiting the registrar", async () => {
    let resolve!: (value: ReturnType<typeof batch>) => void;
    let entered!: () => void;
    const fetching = new Promise<void>((r) => { entered = r; });
    mocks.page.mockImplementationOnce(() => { entered(); return new Promise((r) => { resolve = r; }); });
    const first = syncNamecheapDomains();
    await fetching;
    expect(await syncNamecheapDomains()).toMatchObject({ ok: true, reason: "already_running", imported: 0 });
    expect(mocks.page).toHaveBeenCalledTimes(1);
    resolve(batch());
    expect(await first).toMatchObject({ ok: true, imported: 1 });
  });

  it("fences an expired worker and does not release a successor's lease", async () => {
    mocks.page.mockImplementationOnce(async () => {
      store.now = new Date("2026-10-16T00:06:00Z");
      store.lease = { ...store.lease, detail: "new-owner", receivedAt: new Date("2026-10-16T00:06:00Z") };
      return batch();
    });
    expect(await syncNamecheapDomains()).toMatchObject({ ok: false, imported: 0, errors: [{ code: "LEASE_LOST", page: 1 }] });
    expect(store.rows.size).toBe(0);
    expect(store.lease).toMatchObject({ outcome: "running", detail: "new-owner" });
  });

  it("recovers a crashed worker's expired lease", async () => {
    store.lease = { outcome: "running", detail: "dead-owner", receivedAt: new Date("2026-10-15") };
    expect(await syncNamecheapDomains()).toMatchObject({ ok: true, imported: 1 });
  });

  it("fences an expired lease even if no successor has claimed it", async () => {
    mocks.page.mockImplementationOnce(async () => {
      store.now = new Date("2026-10-16T00:05:00Z");
      return batch();
    });
    expect(await syncNamecheapDomains()).toMatchObject({ ok: false, imported: 0, errors: [{ code: "LEASE_LOST", page: 1 }] });
    expect(store.rows.size).toBe(0);
  });

  it.each(["total", "duplicate"])("stops a changing inventory (%s) without committing the bad page", async (kind) => {
    const first = Array.from({ length: 100 }, (_, i) => domain(`d-${i}.com`));
    mocks.page.mockResolvedValueOnce(batch(first, 1, 101))
      .mockResolvedValueOnce(batch([kind === "duplicate" ? first[0] : domain()], 2, kind === "total" ? 102 : 101));
    expect(await syncNamecheapDomains()).toMatchObject({ ok: false, imported: 100,
      errors: [{ code: kind === "total" ? "INVENTORY_CHANGED" : "DUPLICATE_DOMAIN", page: 2 }] });
    expect(store.rows.size).toBe(100);
  });

  it("stops at the duration limit after a slow registrar call", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    mocks.page.mockImplementationOnce(async () => {
      clock.mockReturnValue(10 * 60_000);
      return batch();
    });
    try {
      expect(await syncNamecheapDomains()).toMatchObject({ ok: false, imported: 0, errors: [{ code: "DURATION_LIMIT", page: 1 }] });
      expect(store.rows.size).toBe(0);
    } finally { clock.mockRestore(); }
  });

  it("aborts if configuration switches to sandbox after the lease claim", async () => {
    mocks.mode.mockReturnValueOnce("live").mockReturnValue("sandbox");
    expect(await syncNamecheapDomains()).toMatchObject({ ok: false, errors: [{ code: "LIVE_MODE_REQUIRED", page: 1 }] });
    expect(mocks.page).not.toHaveBeenCalled();
    expect(store.rows.size).toBe(0);
  });

  it("rejects excess inventory before writing and bounds the request count", async () => {
    mocks.page.mockResolvedValue(batch([], 1, 10_001));
    expect(await syncNamecheapDomains()).toMatchObject({ ok: false, imported: 0, errors: [{ code: "PAGE_LIMIT", page: 1 }] });
    expect(mocks.page).toHaveBeenCalledTimes(1);
    expect(store.rows.size).toBe(0);
  });

  it("reports partial progress safely when an upstream page fails, then permits a retry", async () => {
    mocks.page.mockResolvedValueOnce(batch(Array.from({ length: 100 }, (_, i) => domain(`d-${i}.com`)), 1, 101))
      .mockRejectedValueOnce(new Error("ApiKey=SECRET&UserName=PRIVATE"));
    const result = await syncNamecheapDomains();
    expect(result).toMatchObject({ ok: false, pages: 1, imported: 100, errors: [{ code: "SYNC_FAILED", page: 2 }] });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|PRIVATE/);
    expect(store.lease.outcome).toBe("failed");
    expect(await syncNamecheapDomains()).toMatchObject({ ok: true });
  });

  it("rolls a failed write page back and does not overcount it", async () => {
    mocks.page.mockResolvedValue(batch([domain(), domain("second.com")]));
    store.tx.domain.createMany.mockImplementationOnce(async () => ({ count: 1 })).mockRejectedValueOnce(new Error("secret SQL parameters"));
    expect(await syncNamecheapDomains()).toMatchObject({ ok: false, imported: 0, updated: 0 });
    expect(store.rows.size).toBe(0);
  });

  it.each(["sandbox", "off"])("fails closed in %s mode without contacting the DB or registrar", async (mode) => {
    mocks.mode.mockReturnValue(mode);
    expect(await syncNamecheapDomains()).toMatchObject({ ok: false, reason: mode === "sandbox" ? "sandbox_disabled" : "not_configured" });
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.page).not.toHaveBeenCalled();
  });

  it("does not silently succeed without a database", async () => {
    mocks.getDb.mockResolvedValue(null);
    expect(await syncNamecheapDomains()).toMatchObject({ ok: false, reason: "database_unavailable" });
    expect(mocks.page).not.toHaveBeenCalled();
  });

  it("reports release failure safely rather than masking successful page counts", async () => {
    store.tx.webhookEvent.updateMany.mockRejectedValueOnce(new Error("secret connection details"));
    expect(await syncNamecheapDomains()).toMatchObject({ ok: false, reason: "sync_failed", imported: 1,
      errors: [{ code: "LEASE_RELEASE_FAILED", page: null }] });
  });
});