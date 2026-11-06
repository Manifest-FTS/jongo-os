import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ auth: vi.fn(), findUser: vi.fn(), updateUser: vi.fn(), createCustomer: vi.fn(), createSession: vi.fn(), price: vi.fn() }));
vi.mock("@/lib/auth.config", () => ({ auth: m.auth }));
vi.mock("@/lib/db", () => ({ db: { user: { findUnique: m.findUser, update: m.updateUser } } }));
vi.mock("@/lib/stripe", () => ({
  findPlan: (id: string) => (id === "pro" ? { id: "pro", name: "Pro" } : undefined),
  ensureStripePrice: m.price,
  getStripeClient: () => ({ customers: { create: m.createCustomer }, checkout: { sessions: { create: m.createSession } } })
}));

import { POST } from "../app/api/billing/checkout/route";

const post = (body: unknown) => POST(new Request("http://x/api/billing/checkout", { method: "POST", body: JSON.stringify(body) }));
const customer = { id: "u1", email: "c@example.test", deletedAt: null, stripeCustomerId: null, stripeSubscriptionId: null, subscriptionStatus: null, subscriptionCurrentPeriodEnd: null };

beforeEach(() => {
  vi.clearAllMocks();
  m.auth.mockResolvedValue({ user: { id: "u1" } });
  m.findUser.mockResolvedValue(customer);
  m.createCustomer.mockResolvedValue({ id: "cus_1" });
  m.price.mockResolvedValue("price_1");
  m.createSession.mockResolvedValue({ url: "https://checkout.stripe.test/s/1" });
});

describe("POST /api/billing/checkout", () => {
  it("lets any signed-in customer pay for their own account", async () => {
    const res = await post({ planId: "pro", interval: "monthly" });
    expect(res.status).toBe(200);
    expect((await res.json()).url).toContain("checkout.stripe.test");
    const args = m.createSession.mock.calls[0][0];
    expect(args).toMatchObject({ mode: "subscription", customer: "cus_1", client_reference_id: "u1" });
    expect(args.success_url).toContain("/billing?checkout=success");
  });

  it("refuses signed-out visitors and unknown plans", async () => {
    m.auth.mockResolvedValue(null);
    expect((await post({ planId: "pro" })).status).toBe(401);
    m.auth.mockResolvedValue({ user: { id: "u1" } });
    expect((await post({ planId: "free-money" })).status).toBe(400);
    expect(m.createSession).not.toHaveBeenCalled();
  });

  it("never starts a second subscription for an account that already pays", async () => {
    m.findUser.mockResolvedValue({ ...customer, stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1", subscriptionStatus: "active", subscriptionCurrentPeriodEnd: new Date(Date.now() + 86400000) });
    const res = await post({ planId: "pro" });
    expect(res.status).toBe(409);
    expect((await res.json()).url).toBe("/billing");
    expect(m.createSession).not.toHaveBeenCalled();
  });

  it("lets a cancelled account subscribe again", async () => {
    m.findUser.mockResolvedValue({ ...customer, stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_old", subscriptionStatus: "canceled", subscriptionCurrentPeriodEnd: new Date(Date.now() - 86400000) });
    expect((await post({ planId: "pro" })).status).toBe(200);
    expect(m.createCustomer).not.toHaveBeenCalled();
  });

  it("shows plain words, never Stripe's own error", async () => {
    m.createSession.mockRejectedValue(new Error("Invalid API Key provided: sk_live_****"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await post({ planId: "pro" });
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("sk_");
  });
});
