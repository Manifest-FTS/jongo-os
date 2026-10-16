import { describe, expect, it, vi, afterEach } from "vitest";
import { BILLING_MODES, BILLING_STATUSES, getBillingDriver, type BillingClient, type BillingMode } from "./client-billing-drivers";
import { bonsaiClientUrl, clientBillingDto, pagination, safeInvoiceUrl, validateBillingUpdate } from "./client-billing";
import { readBillingBody } from "./client-billing-http";

vi.mock("@/lib/auth.config", () => ({ auth: vi.fn() }));
vi.mock("@/lib/rbac", () => ({ resolvePrincipal: vi.fn(), canManageBilling: vi.fn() }));

const client: BillingClient = {
  id: "10000000-0000-0000-0000-000000000001", name: "Client A", billingMode: "manual_override", billingStatus: "past_due",
  billingNotes: "Private note", bonsaiClientId: "client_123", externalInvoiceUrl: "https://invoices.example.test/123"
};

afterEach(() => vi.unstubAllGlobals());

describe("organization-only billing drivers", () => {
  it.each(BILLING_STATUSES)("manual reads persisted %s without mutation", async (billingStatus) => {
    const row = Object.freeze({ ...client, billingStatus });
    const driver = getBillingDriver("manual_override");
    expect((await driver.getClientStatus(row)).billingStatus).toBe(billingStatus);
    expect(await driver.syncClient(row)).toMatchObject({ billingStatus, supported: true, mutated: false });
    expect(row.billingStatus).toBe(billingStatus);
  });

  it.each(["bonsai", "native_stripe"] as const)("%s is explicitly unsupported even with a stale paid flag", async (mode) => {
    const network = vi.fn(() => { throw new Error("Network must not be used"); });
    vi.stubGlobal("fetch", network);
    const row = Object.freeze({ ...client, billingMode: mode, billingStatus: "active_paid" as const });
    const driver = getBillingDriver(mode);
    expect(await driver.getClientStatus(row)).toMatchObject({ billingStatus: null, supported: false, source: mode });
    expect(await driver.syncClient(row)).toMatchObject({ billingStatus: null, supported: false, mutated: false });
    expect(row.billingStatus).toBe("active_paid");
    expect(network).not.toHaveBeenCalled();
  });

  it("exempt comped is derived only, not persisted", async () => {
    const row = Object.freeze({ ...client, billingMode: "exempt" as const });
    expect(await getBillingDriver("exempt").syncClient(row)).toMatchObject({ billingStatus: "comped", mutated: false });
    expect(row.billingStatus).toBe("past_due");
  });

  it("has an exhaustive factory with no fallback on unknown/missing modes", () => {
    for (const mode of BILLING_MODES) expect(getBillingDriver(mode)).toBeDefined();
    expect(() => getBillingDriver("unknown" as BillingMode)).toThrow("Unsupported");
    expect(() => getBillingDriver(undefined as unknown as BillingMode)).toThrow("Unsupported");
  });

  it("rejects invalid persisted manual status", async () => {
    await expect(getBillingDriver("manual_override").getClientStatus({ ...client, billingStatus: "paid" as never })).rejects.toThrow("Invalid persisted");
  });

  it("returns only explicit financial DTO fields and sanitizes stored unsafe URLs", async () => {
    const dto = await clientBillingDto({ ...client, externalInvoiceUrl: "javascript:alert(1)", stripeSecret: "SECRET", stripeSubscriptionId: "sub_123" } as BillingClient);
    expect(Object.keys(dto).sort()).toEqual(["id", "name", "billingMode", "billingStatus", "supported", "message", "billingNotes", "bonsaiClientId", "bonsaiUrl", "externalInvoiceUrl"].sort());
    expect(dto.externalInvoiceUrl).toBeNull();
    expect(JSON.stringify(dto)).not.toContain("SECRET");
    expect(bonsaiClientUrl("a/b?x=<script>")).toBe("https://app.hellobonsai.com/clients/a%2Fb%3Fx%3D%3Cscript%3E");
  });
});

describe("billing update and URL validation", () => {
  it.each([null, [], "text", {}, { stripeCustomerId: "cus_123" }, { ownerId: "other" }, { billingNotes: "ok", name: "renamed" }, { billingMode: "stripe" }, { billingStatus: "paid" }, { billingNotes: "x".repeat(4001) }, { bonsaiClientId: "../../evil" }, { billingNotes: 1 }, { billingStatus: null }])("rejects invalid/mass-assigned input %#", (input) => {
    expect(() => validateBillingUpdate(input, "manual_override")).toThrow();
  });

  it("allows only explicit typed fields and trims nullable text", () => {
    expect(validateBillingUpdate({ billingStatus: "comped", billingNotes: " courtesy ", bonsaiClientId: "", externalInvoiceUrl: null }, "manual_override"))
      .toEqual({ billingStatus: "comped", billingNotes: "courtesy", bonsaiClientId: null, externalInvoiceUrl: null });
  });

  it("resets stale stored status on mode transitions and rejects external/exempt overrides", () => {
    expect(validateBillingUpdate({ billingMode: "exempt" }, "manual_override")).toEqual({ billingMode: "exempt", billingStatus: "pending_setup" });
    expect(validateBillingUpdate({ billingMode: "manual_override" }, "exempt").billingStatus).toBe("pending_setup");
    for (const mode of ["bonsai", "native_stripe", "exempt"] as const) {
      expect(() => validateBillingUpdate({ billingStatus: "active_paid" }, mode)).toThrow("Only manual");
      expect(() => validateBillingUpdate({ billingMode: mode, billingStatus: "comped" }, "manual_override")).toThrow("Only manual");
    }
  });

  it.each(["javascript:alert(1)", "http://invoice.test", "//invoice.test", "https://user:pass@invoice.test", "https://invoice.test\\@evil.test", "https://invoice.test/\nfoo", "data:text/html,hi", "https://invoice.test/ x"])("rejects unsafe URL %s", (value) => {
    expect(safeInvoiceUrl(value)).toBeNull();
    expect(() => validateBillingUpdate({ externalInvoiceUrl: value }, "manual_override")).toThrow();
  });

  it("accepts HTTPS invoices and bounds pagination", () => {
    expect(safeInvoiceUrl("https://invoice.test/i/123?a=1")).toBe("https://invoice.test/i/123?a=1");
    expect(pagination(new URLSearchParams())).toEqual({ page: 1, pageSize: 50, skip: 0, take: 50 });
    expect(pagination(new URLSearchParams("page=2&pageSize=100"))).toEqual({ page: 2, pageSize: 100, skip: 100, take: 100 });
    for (const query of ["page=0", "page=-1", "page=1.5", "page=10001", "page=Infinity", "pageSize=101", "pageSize=0", "pageSize=1e2"]) {
      expect(() => pagination(new URLSearchParams(query))).toThrow();
    }
  });
});

describe("bounded body parser", () => {
  it("bounds chunked bytes without trusting Content-Length", async () => {
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(16385)); controller.close(); } });
    const request = new Request("https://example.test", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
    await expect(readBillingBody(request)).rejects.toMatchObject({ status: 413 });
  });
  it("rejects malformed, oversized, and non-JSON bodies", async () => {
    for (const [body, headers, status] of [
      ["{", { "Content-Type": "application/json" }, 400],
      ["{}", { "Content-Type": "text/plain" }, 415],
      ["{}", { "Content-Type": "application/json", "Content-Length": "999999" }, 413]
    ] as const) {
      await expect(readBillingBody(new Request("https://example.test", { method: "PATCH", body, headers }))).rejects.toMatchObject({ status });
    }
  });
});