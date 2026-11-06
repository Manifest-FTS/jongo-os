import { describe, expect, it } from "vitest";
import { checkCustomStagingDomainEntitlement } from "./hosting-entitlement";

const future = new Date(Date.now() + 7 * 86400_000);
function deps(org: Record<string, unknown> | null, admins: string[] = [], env: Record<string, string> = {}) {
  return {
    db: { organization: { findUnique: async () => org } },
    isPlatformAdmin: async (id: string) => admins.includes(id),
    now: () => new Date(),
    env
  };
}
const owner = (planId: string | null, status = "active") => ({
  ownerId: "owner",
  billingMode: "native_stripe",
  billingStatus: null,
  owner: { id: "owner", deletedAt: null, subscriptionStatus: status, subscriptionCurrentPeriodEnd: future, subscriptionPlanId: planId }
});
const input = { organizationId: "org", actorUserId: "owner" };

describe("custom staging domains by plan", () => {
  it("allows Core SLA and Enterprise SLA", async () => {
    expect(await checkCustomStagingDomainEntitlement(input, deps(owner("core-sla")))).toMatchObject({ ok: true, via: "plan" });
    expect(await checkCustomStagingDomainEntitlement(input, deps(owner("enterprise-sla")))).toMatchObject({ ok: true });
  });

  it("asks Starter and Pro owners to upgrade, pointing at billing", async () => {
    const result = await checkCustomStagingDomainEntitlement(input, deps(owner("pro")));
    expect(result).toMatchObject({ ok: false, actorIsOwner: true, actionUrl: "/billing" });
  });

  it("refuses an unpaid Core SLA plan", async () => {
    expect(await checkCustomStagingDomainEntitlement(input, deps(owner("core-sla", "canceled")))).toMatchObject({ ok: false });
  });

  it("tells a non-owner who can upgrade, with no billing link", async () => {
    const result = await checkCustomStagingDomainEntitlement({ ...input, actorUserId: "member" }, deps(owner("starter")));
    expect(result).toMatchObject({ ok: false, actorIsOwner: false, actionUrl: null });
  });

  it("exempts agency clients, agency billing and platform admins", async () => {
    expect(await checkCustomStagingDomainEntitlement(input, deps(owner("starter"), ["owner"]))).toMatchObject({ ok: true });
    expect(
      await checkCustomStagingDomainEntitlement(input, deps({ ...owner(null), billingMode: "manual", billingStatus: "active_paid" }))
    ).toMatchObject({ ok: true, via: "agency_billing" });
    expect(await checkCustomStagingDomainEntitlement(input, deps(owner(null), [], { HOSTING_REQUIRES_PAYMENT: "false" }))).toMatchObject({ ok: true });
  });
});
