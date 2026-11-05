/**
 * May this client get NEW hosting (a hosting project, a new app)?
 *
 * Paying is per account (the User model's subscription): a client is covered
 * by its owner's plan, the same rule CMS features already use. Exempt:
 *   - platform admins, and clients owned by one (the agency's own clients);
 *   - clients the agency bills outside Stripe (manual or Bonsai) that are
 *     marked paid (Organization.billingStatus = active_paid).
 *
 * Only new hosting is gated. Apps that already exist keep running, deploying
 * and being managed whatever the plan does; suspending them is a separate,
 * deliberate decision.
 *
 * HOSTING_REQUIRES_PAYMENT=false turns the gate off (for a self-hosted install
 * with no billing).
 */

export type HostingEntitlement =
  | { ok: true; via: "not_required" | "platform_admin" | "agency_client" | "agency_billing" | "subscription" }
  | { ok: false; reason: "payment_required" | "payment_past_due"; actorIsOwner: boolean; message: string };

/** The Stripe statuses that count as paid for new hosting. */
const PAID = new Set(["active", "trialing"]);

export function paymentRequired(env: Record<string, string | undefined> = process.env): boolean {
  return (env.HOSTING_REQUIRES_PAYMENT ?? "").trim().toLowerCase() !== "false";
}

export type SubscriptionFields = {
  subscriptionStatus: string | null;
  subscriptionCurrentPeriodEnd: Date | null;
  deletedAt?: Date | null;
};

/** An account's plan is paid up (and not past its period end). */
export function subscriptionIsPaid(user: SubscriptionFields | null | undefined, now = new Date()): boolean {
  if (!user || user.deletedAt) return false;
  if (!user.subscriptionStatus || !PAID.has(user.subscriptionStatus)) return false;
  const end = user.subscriptionCurrentPeriodEnd;
  return end instanceof Date && Number.isFinite(end.getTime()) && end.getTime() > now.getTime();
}

type Deps = { db: any; isPlatformAdmin: (userId: string) => Promise<boolean>; now: () => Date; env: Record<string, string | undefined> };

async function defaultDeps(): Promise<Deps> {
  const [{ db }, rbac] = await Promise.all([import("@/lib/db"), import("@/lib/rbac")]);
  return { db, isPlatformAdmin: (id) => rbac.isPlatformAdminUser(id), now: () => new Date(), env: process.env };
}

export async function checkHostingEntitlement(
  input: { organizationId: string; actorUserId: string },
  injected?: Partial<Deps>
): Promise<HostingEntitlement> {
  const deps = { ...(await defaultDeps()), ...injected } as Deps;
  if (!paymentRequired(deps.env)) return { ok: true, via: "not_required" };
  if (await deps.isPlatformAdmin(input.actorUserId)) return { ok: true, via: "platform_admin" };

  const org = await deps.db.organization.findUnique({
    where: { id: input.organizationId },
    select: {
      ownerId: true,
      billingMode: true,
      billingStatus: true,
      owner: { select: { id: true, deletedAt: true, subscriptionStatus: true, subscriptionCurrentPeriodEnd: true } }
    }
  });
  const actorIsOwner = org?.ownerId === input.actorUserId;
  if (!org) {
    return { ok: false, reason: "payment_required", actorIsOwner: false, message: "This client wasn't found." };
  }
  if (org.ownerId && (await deps.isPlatformAdmin(org.ownerId))) return { ok: true, via: "agency_client" };
  if (org.billingMode !== "native_stripe" && org.billingStatus === "active_paid") return { ok: true, via: "agency_billing" };
  if (subscriptionIsPaid(org.owner, deps.now())) return { ok: true, via: "subscription" };

  const pastDue = org.owner?.subscriptionStatus === "past_due" || org.owner?.subscriptionStatus === "unpaid";
  return {
    ok: false,
    reason: pastDue ? "payment_past_due" : "payment_required",
    actorIsOwner,
    message: pastDue
      ? actorIsOwner
        ? "Your last payment didn't go through. Update your payment method to add new apps; your current apps keep running."
        : "This client's plan has a payment problem, so new apps can't be added until the owner updates their payment method."
      : actorIsOwner
        ? "Choose a plan to start hosting apps. Your apps go live as soon as payment is confirmed."
        : "This client's owner needs an active plan before new apps can be added."
  };
}

/** The JSON answer routes give when payment is needed (HTTP 402). */
export function paymentRequiredBody(entitlement: Extract<HostingEntitlement, { ok: false }>) {
  return {
    ok: false,
    error: entitlement.message,
    message: entitlement.message,
    reason: entitlement.reason,
    // Only the owner can pay; others are told who must.
    actionUrl: entitlement.actorIsOwner ? (entitlement.reason === "payment_past_due" ? "/billing" : "/pricing") : null
  };
}

/** Plans that include the client's own domain on staging (pricing matrix). */
export const CUSTOM_STAGING_DOMAIN_PLANS = new Set(["core-sla", "enterprise-sla"]);

export type PlanFeatureEntitlement =
  | { ok: true; via: "not_required" | "platform_admin" | "agency_client" | "agency_billing" | "plan" }
  | { ok: false; actorIsOwner: boolean; message: string; actionUrl: string | null };

/**
 * May this client ADD a custom staging domain? Same exemptions as hosting;
 * otherwise the owner's paid plan must be Core SLA or Enterprise SLA. Domains
 * already added keep working whatever the plan does.
 */
export async function checkCustomStagingDomainEntitlement(
  input: { organizationId: string; actorUserId: string },
  injected?: Partial<Deps>
): Promise<PlanFeatureEntitlement> {
  const deps = { ...(await defaultDeps()), ...injected } as Deps;
  if (!paymentRequired(deps.env)) return { ok: true, via: "not_required" };
  if (await deps.isPlatformAdmin(input.actorUserId)) return { ok: true, via: "platform_admin" };

  const org = await deps.db.organization.findUnique({
    where: { id: input.organizationId },
    select: {
      ownerId: true,
      billingMode: true,
      billingStatus: true,
      owner: { select: { id: true, deletedAt: true, subscriptionStatus: true, subscriptionCurrentPeriodEnd: true, subscriptionPlanId: true } }
    }
  });
  const actorIsOwner = org?.ownerId === input.actorUserId;
  if (org?.ownerId && (await deps.isPlatformAdmin(org.ownerId))) return { ok: true, via: "agency_client" };
  if (org && org.billingMode !== "native_stripe" && org.billingStatus === "active_paid") return { ok: true, via: "agency_billing" };
  if (org && subscriptionIsPaid(org.owner, deps.now()) && CUSTOM_STAGING_DOMAIN_PLANS.has(org.owner?.subscriptionPlanId ?? "")) {
    return { ok: true, via: "plan" };
  }
  return {
    ok: false,
    actorIsOwner,
    message: actorIsOwner
      ? "Your own staging domain comes with the Core SLA and Enterprise SLA plans. Upgrade to add one."
      : "Your own staging domain comes with the Core SLA and Enterprise SLA plans. The client's owner can upgrade to add one.",
    actionUrl: actorIsOwner ? "/billing" : null
  };
}
