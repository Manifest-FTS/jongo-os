import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ verify: vi.fn(), auth: vi.fn(), update: vi.fn(), user: vi.fn() }));
vi.mock("@/lib/stripe", () => ({ getStripeClient: () => ({ webhooks: { constructEvent: m.verify } }) }));
vi.mock("@/lib/auth.config", () => ({ auth: m.auth }));
vi.mock("@/lib/db", () => ({ db: { user: { update: m.update, findUnique: m.user } } }));
import { POST } from "../app/api/billing/webhook/route";

describe("Stripe machine webhook remains signature-only", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "test-signing-secret");
  });
  afterEach(() => vi.unstubAllEnvs());
  it("accepts a signed event without a user or financial principal", async () => {
    m.verify.mockReturnValue({ type: "customer.subscription.updated", data: { object: { id: "sub", metadata: { jongoUserId: "u" }, status: "active", current_period_end: 123 } } });
    m.user.mockResolvedValue({ id: "u" });
    const response = await POST(new Request("https://example.test/api/billing/webhook", { method: "POST", body: "raw-event", headers: { "stripe-signature": "signed" } }));
    expect(response.status).toBe(200);
    expect(m.verify).toHaveBeenCalledWith("raw-event", "signed", "test-signing-secret");
    expect(m.update).toHaveBeenCalledWith({ where: { id: "u" }, data: { subscriptionStatus: "active", subscriptionCurrentPeriodEnd: new Date(123000) } });
    expect(m.auth).not.toHaveBeenCalled();
  });
  it("rejects an invalid signature without touching billing state", async () => {
    m.verify.mockImplementation(() => { throw new Error("invalid signature"); });
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await POST(new Request("https://example.test/api/billing/webhook", { method: "POST", body: "unsigned" }))).status).toBe(400);
      expect(m.update).not.toHaveBeenCalled();
      expect(m.auth).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
});