import { describe, expect, it, vi } from "vitest";
import { checkHostingEntitlement, paymentRequiredBody, subscriptionIsPaid } from "./hosting-entitlement";

const NOW = new Date("2026-11-05T12:00:00Z");
const future = new Date("2026-12-05T12:00:00Z");
const past = new Date("2026-10-05T12:00:00Z");

function deps(org: any, admins: string[] = [], env: Record<string, string> = {}) {
  return {
    db: { organization: { findUnique: vi.fn(async () => org) } },
    isPlatformAdmin: async (id: string) => admins.includes(id),
    now: () => NOW,
    env
  };
}
const org = (owner: any, extra: any = {}) => ({ ownerId: "owner", billingMode: "native_stripe", billingStatus: "pending_setup", owner: { id: "owner", deletedAt: null, ...owner }, ...extra });

describe("subscriptionIsPaid", () => {
  it("counts active and trialing plans inside their period", () => {
    expect(subscriptionIsPaid({ subscriptionStatus: "active", subscriptionCurrentPeriodEnd: future }, NOW)).toBe(true);
    expect(subscriptionIsPaid({ subscriptionStatus: "trialing", subscriptionCurrentPeriodEnd: future }, NOW)).toBe(true);
    expect(subscriptionIsPaid({ subscriptionStatus: "active", subscriptionCurrentPeriodEnd: past }, NOW)).toBe(false);
    for (const status of ["past_due", "canceled", "incomplete", null]) {
      expect(subscriptionIsPaid({ subscriptionStatus: status, subscriptionCurrentPeriodEnd: future }, NOW)).toBe(false);
    }
  });
});

describe("checkHostingEntitlement", () => {
  const ask = (o: any, actor = "owner", admins: string[] = [], env: Record<string, string> = {}) =>
    checkHostingEntitlement({ organizationId: "org", actorUserId: actor }, deps(o, admins, env));

  it("allows a client whose owner pays", async () => {
    expect(await ask(org({ subscriptionStatus: "active", subscriptionCurrentPeriodEnd: future }))).toEqual({ ok: true, via: "subscription" });
  });

  it("asks the owner to choose a plan, and tells others who must", async () => {
    const owner = await ask(org({ subscriptionStatus: null, subscriptionCurrentPeriodEnd: null }));
    expect(owner).toMatchObject({ ok: false, reason: "payment_required", actorIsOwner: true });
    expect(owner.ok === false && paymentRequiredBody(owner).actionUrl).toBe("/pricing");
    const teammate = await ask(org({ subscriptionStatus: null, subscriptionCurrentPeriodEnd: null }), "teammate");
    expect(teammate.ok === false && paymentRequiredBody(teammate).actionUrl).toBeNull();
    expect(teammate.ok === false && teammate.message).toContain("owner");
  });

  it("points a failed payment to Billing", async () => {
    const result = await ask(org({ subscriptionStatus: "past_due", subscriptionCurrentPeriodEnd: future }));
    expect(result).toMatchObject({ ok: false, reason: "payment_past_due" });
    expect(result.ok === false && paymentRequiredBody(result).actionUrl).toBe("/billing");
  });

  it("never blocks the agency: platform admins, their clients, and clients billed outside Stripe", async () => {
    const unpaid = org({ subscriptionStatus: null, subscriptionCurrentPeriodEnd: null });
    expect(await ask(unpaid, "staff", ["staff"])).toEqual({ ok: true, via: "platform_admin" });
    expect(await ask(unpaid, "teammate", ["owner"])).toEqual({ ok: true, via: "agency_client" });
    expect(await ask({ ...unpaid, billingMode: "bonsai", billingStatus: "active_paid" })).toEqual({ ok: true, via: "agency_billing" });
    // Marked paid but billed through Stripe: the Stripe plan decides.
    expect((await ask({ ...unpaid, billingStatus: "active_paid" })).ok).toBe(false);
  });

  it("can be switched off for installs without billing", async () => {
    expect(await ask(org({ subscriptionStatus: null }), "owner", [], { HOSTING_REQUIRES_PAYMENT: "false" })).toEqual({ ok: true, via: "not_required" });
  });
});
