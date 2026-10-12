import { describe, expect, it } from "vitest";
import { chargeRemedies } from "./domain-display";

const base = { status: "failed", stripePaymentIntentId: "pi_1", stripeRefundId: null as string | null, updatedAt: new Date(0) };
const now = 60 * 60_000;

describe("chargeRemedies", () => {
  it("offers Refund for a failed charge whose refund did not go through", () => {
    expect(chargeRemedies({ ...base }, now)).toEqual(["refund_domain_order"]);
  });

  it("never offers a second refund", () => {
    expect(chargeRemedies({ ...base, stripeRefundId: "re_1" }, now)).toEqual([]);
    expect(chargeRemedies({ ...base, status: "refunded", stripeRefundId: "re_1" }, now)).toEqual([]);
  });

  it("cannot refund without a recorded payment", () => {
    expect(chargeRemedies({ ...base, stripePaymentIntentId: null }, now)).toEqual([]);
  });

  it("offers Retry and Refund for an order stuck mid-way for 30 minutes", () => {
    expect(chargeRemedies({ ...base, status: "fulfilling" }, now)).toEqual(["retry_domain_order", "refund_domain_order"]);
  });

  it("leaves an order alone while it is still running", () => {
    expect(chargeRemedies({ ...base, status: "fulfilling", updatedAt: new Date(now - 5 * 60_000) }, now)).toEqual([]);
  });

  it("offers nothing for completed or pending charges", () => {
    expect(chargeRemedies({ ...base, status: "fulfilled" }, now)).toEqual([]);
    expect(chargeRemedies({ ...base, status: "pending_payment" }, now)).toEqual([]);
  });
});
