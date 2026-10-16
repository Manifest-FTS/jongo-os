import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ auth: vi.fn(), prices: vi.fn(), availability: vi.fn() }));
vi.mock("@/lib/auth.config", () => ({ auth: m.auth }));
vi.mock("@/lib/registrar", () => ({ isRegistrarConfigured: () => true, getPricesForTlds: m.prices, getTldPricing: async () => new Map(), checkAvailability: m.availability }));
import { GET as pricing } from "../app/api/domains/pricing/route";
import { POST as search } from "../app/api/domains/search/route";

describe("public marketing prices stay public and retail-only", () => {
  beforeEach(() => vi.resetAllMocks());
  it("allowlists public price/search output, never spreads wholesale/private fields", async () => {
    const privateFields = { wholesaleCents: 1000, markupCents: 250, stripeCustomerId: "private", billingOverride: true };
    m.prices.mockResolvedValue([{ tld: "com", registrationCents: 1250, renewalCents: 1500, transferCents: 1250, ...privateFields }]);
    m.availability.mockResolvedValue({ state: "available", domain: "example.com", priceCents: 1250, priceDisplay: "$12.50", renewalCents: 1500, transferCents: 1250, regularPriceCents: 1500, premium: false, firstYearPromo: true, minDuration: 1, sandbox: false, ...privateFields });
    const prices = await pricing();
    const result = await search(new Request("https://example.test/api/domains/search", { method: "POST", body: JSON.stringify({ domain: "example.com" }) }));
    expect(prices.status).toBe(200);
    expect(result.status).toBe(200);
    const json = JSON.stringify([await prices.json(), await result.json()]);
    expect(json).toContain("1250");
    expect(json).not.toMatch(/wholesale|markup|stripe|billingOverride/);
    expect(m.auth).not.toHaveBeenCalled();
  });
});