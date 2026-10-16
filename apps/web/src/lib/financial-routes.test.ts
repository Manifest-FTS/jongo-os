import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ auth: vi.fn(), viewer: vi.fn(), getDb: vi.fn(), user: vi.fn(), grant: vi.fn(), quote: vi.fn(), checkout: vi.fn(), retry: vi.fn(), refund: vi.fn(), stripe: vi.fn() }));
vi.mock("@/lib/auth.config", () => ({ auth: m.auth }));
vi.mock("@/lib/db", () => ({ getDb: m.getDb }));
vi.mock("@/lib/domain-access", () => ({ getDomainViewer: m.viewer }));
vi.mock("@/lib/domain-orders", () => ({ quoteOrder: m.quote, startDomainCheckout: m.checkout, retryDomainCharge: m.retry, retryDomainRefund: m.refund }));
vi.mock("@/lib/stripe", () => ({ getStripeClient: m.stripe, findPlan: vi.fn(), ensureStripePrice: vi.fn() }));
import { POST as subscription } from "../app/api/billing/checkout/route";
import { POST as checkout } from "../app/api/domains/checkout/route";
import { GET as quote } from "../app/api/domains/quote/route";
import { POST as remedy } from "../app/api/domains/charges/[chargeId]/remedies/route";

function request(body?: unknown) {
  return new Request("https://example.test/api/domains/quote?domain=example.com", {
    method: body ? "POST" : "GET", ...(body ? { body: JSON.stringify(body) } : {})
  });
}

describe("financial route denials before parsing/provider calls", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m.auth.mockResolvedValue({ user: { id: "u", email: "seed@example.com", role: "super_admin" } });
    m.viewer.mockResolvedValue({ userId: "u", email: "seed@example.com", isPlatformAdmin: true, isSuperAdmin: false });
    m.getDb.mockResolvedValue({ user: { findUnique: m.user }, platformAdmin: { findUnique: m.grant } });
    m.grant.mockResolvedValue({ id: "technical-grant" });
    m.user.mockResolvedValue({ id: "u", email: "seed@example.com", role: "admin", deletedAt: null });
  });

  const routes = [
    () => subscription(request({ planId: "any" })),
    () => checkout(request({ operation: "register", domain: "example.com", organizationId: "client" })),
    () => quote(request()),
    () => remedy(request({ action: "refund_domain_order" }), { params: Promise.resolve({ chargeId: "charge" }) })
  ];

  it.each(["admin", "collaborator"])("denies %s despite stale JWT super role and platform grant", async (role) => {
    m.user.mockResolvedValue({ id: "u", email: "seed@example.com", role, deletedAt: null });
    for (const route of routes) {
      const response = await route();
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(JSON.stringify(await response.json())).not.toMatch(/Cents|stripe|wholesale|markup/);
    }
    for (const spy of [m.quote, m.checkout, m.retry, m.refund, m.stripe]) expect(spy).not.toHaveBeenCalled();
  });

  it("denies anonymous calls", async () => {
    m.auth.mockResolvedValue(null);
    m.viewer.mockResolvedValue(null);
    for (const route of routes) expect((await route()).status).toBe(401);
  });

  it("denies deleted and unavailable identities", async () => {
    for (const user of [null, { id: "u", role: "super_admin", deletedAt: new Date() }]) {
      m.user.mockResolvedValue(user);
      for (const route of routes) expect((await route()).status).toBe(403);
    }
    m.getDb.mockResolvedValue(null);
    for (const route of routes) expect((await route()).status).toBe(403);
  });

  it("allows a fresh super admin's quote and remedy", async () => {
    m.user.mockResolvedValue({ id: "u", email: "super@example.com", role: "super_admin", deletedAt: null });
    m.viewer.mockResolvedValue({ userId: "u", isSuperAdmin: true, isPlatformAdmin: true });
    m.quote.mockResolvedValue({ ok: true, domain: { domain: "example.com" }, quote: { operation: "register", years: 1, clientCents: 1250, wholesaleCents: 1000, markupPercent: 25, markupCents: 250 } });
    const response = await quote(request());
    expect(response.status).toBe(200);
    expect((await response.json()).admin.wholesaleCents).toBe(1000);
    m.refund.mockResolvedValue({ ok: true, message: "refunded" });
    expect((await routes[3]()).status).toBe(200);
    expect(m.refund).toHaveBeenCalledWith("charge");
  });
});