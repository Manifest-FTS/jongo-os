import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ verify: vi.fn(), auth: vi.fn(), apply: vi.fn(), payment: vi.fn(), fulfil: vi.fn(), expire: vi.fn() }));
vi.mock("@/lib/stripe", () => ({ getStripeClient: () => ({ webhooks: { constructEvent: m.verify } }) }));
vi.mock("@/lib/auth.config", () => ({ auth: m.auth }));
vi.mock("@/lib/billing/subscription-events", () => ({ applySubscriptionEvent: m.apply }));
vi.mock("@/lib/domain-orders", () => ({ recordDomainPayment: m.payment, fulfilDomainCharge: m.fulfil, handleDomainCheckoutExpired: m.expire }));
import { POST } from "../app/api/billing/webhook/route";

const payload = "SENTINEL_PRIVATE_WEBHOOK_PAYLOAD";
const header = "SENTINEL_PRIVATE_SIGNATURE_HEADER";
function providerError() {
  return Object.assign(new Error(`${payload} ${header}`), {
    payload, header, raw: { request: payload, headers: { "stripe-signature": header } },
    toJSON: vi.fn(() => { throw new Error("SDK error must not be serialized"); })
  });
}

describe("Stripe machine webhook remains signature-only", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "test-signing-secret");
  });
  afterEach(() => vi.unstubAllEnvs());
  it("accepts a signed event without a user or financial principal", async () => {
    m.verify.mockReturnValue({ type: "customer.subscription.updated", data: { object: { id: "sub", metadata: { jongoUserId: "u" }, status: "active", current_period_end: 123 } } });
    const response = await POST(new Request("https://example.test/api/billing/webhook", { method: "POST", body: "raw-event", headers: { "stripe-signature": "signed" } }));
    expect(response.status).toBe(200);
    expect(m.verify).toHaveBeenCalledWith(Buffer.from("raw-event"), "signed", "test-signing-secret");
    expect(m.apply).toHaveBeenCalledWith(m.verify.mock.results[0].value);
    expect(m.auth).not.toHaveBeenCalled();
  });
  it("rejects an invalid signature without touching billing state", async () => {
    const error = providerError();
    m.verify.mockImplementation(() => { throw error; });
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await POST(new Request("https://example.test/api/billing/webhook", { method: "POST", body: payload, headers: { "stripe-signature": header } }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid signature" });
      expect(log.mock.calls).toEqual([["[billing/webhook] signature_verification_failed"]]);
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/SENTINEL/);
      expect(error.toJSON).not.toHaveBeenCalled();
      expect(m.apply).not.toHaveBeenCalled();
      expect(m.payment).not.toHaveBeenCalled();
      expect(m.fulfil).not.toHaveBeenCalled();
      expect(m.expire).not.toHaveBeenCalled();
      expect(m.auth).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
  it("bounds streamed bytes before signature verification even with a false length", async () => {
    const req = new Request("https://example.test/api/billing/webhook", { method: "POST", body: "x".repeat(1024 * 1024 + 1), headers: { "content-length": "1" } });
    expect((await POST(req)).status).toBe(413);
    expect(m.verify).not.toHaveBeenCalled();
    expect(m.apply).not.toHaveBeenCalled();
  });
  it("accepts exactly one MiB without parsing before signature verification", async () => {
    m.verify.mockReturnValue({ type: "ignored" });
    expect((await POST(new Request("https://example.test", { method: "POST", body: "x".repeat(1024 * 1024) }))).status).toBe(200);
    expect(m.verify.mock.calls[0][0].byteLength).toBe(1024 * 1024);
  });
  it("retains domain payment recording then asynchronous fulfillment without subscription reconciliation", async () => {
    const session = { metadata: { jongoKind: "domain" } };
    m.verify.mockReturnValue({ type: "checkout.session.completed", data: { object: session } });
    m.payment.mockResolvedValue("charge");
    m.fulfil.mockResolvedValue(undefined);
    expect((await POST(new Request("https://example.test", { method: "POST", body: "signed" }))).status).toBe(200);
    expect(m.payment).toHaveBeenCalledWith(session);
    expect(m.fulfil).toHaveBeenCalledWith("charge");
    expect(m.payment.mock.invocationCallOrder[0]).toBeLessThan(m.fulfil.mock.invocationCallOrder[0]);
    expect(m.apply).not.toHaveBeenCalled();
  });
  it("retains domain expiration and subscription checkout dispatch", async () => {
    const session = { metadata: { jongoKind: "domain" } };
    m.verify.mockReturnValue({ type: "checkout.session.expired", data: { object: session } });
    expect((await POST(new Request("https://example.test", { method: "POST", body: "signed" }))).status).toBe(200);
    expect(m.expire).toHaveBeenCalledWith(session);
    const event = { type: "checkout.session.completed", data: { object: { mode: "subscription", subscription: "sub" } } };
    m.verify.mockReturnValue(event);
    await POST(new Request("https://example.test", { method: "POST", body: "signed" }));
    expect(m.apply).toHaveBeenCalledWith(event);
  });
  it("returns retryable failure when transactional subscription processing fails", async () => {
    m.verify.mockReturnValue({ type: "customer.subscription.deleted", data: { object: {} } });
    const error = providerError();
    m.apply.mockRejectedValue(error);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await POST(new Request("https://example.test", { method: "POST", body: "signed" }))).status).toBe(500);
      expect(log.mock.calls).toEqual([["[billing/webhook] event_processing_failed"]]);
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/SENTINEL/);
      expect(error.toJSON).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
  it.each(["payment", "expire", "fulfil"] as const)("redacts %s provider failures without serializing SDK errors", async stage => {
    const error = providerError();
    m.verify.mockReturnValue({ type: stage === "expire" ? "checkout.session.expired" : "checkout.session.completed",
      data: { object: { metadata: { jongoKind: "domain" } } } });
    m.payment.mockResolvedValue(payload);
    m.fulfil.mockResolvedValue(undefined);
    m[stage].mockRejectedValue(error);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(new Request("https://example.test", { method: "POST", body: payload, headers: { "stripe-signature": header } }));
      expect(response.status).toBe(stage === "fulfil" ? 200 : 500);
      expect(await response.json()).toEqual(stage === "fulfil" ? { received: true } : { error: "Failed to process event" });
      expect(log.mock.calls).toEqual([[stage === "fulfil" ? "[billing/webhook] domain_fulfillment_failed" : "[billing/webhook] event_processing_failed"]]);
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/SENTINEL/);
      expect(error.toJSON).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
});