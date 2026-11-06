import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { ensureStripePrice, findPlan, getStripeClient, type BillingInterval } from "@/lib/stripe";

function baseUrl(): string {
  const raw = (process.env.NEXTAUTH_URL || process.env.APP_BASE_URL || "http://localhost:3000").trim();
  return raw.replace(/\/+$/, "");
}

/**
 * POST /api/billing/checkout
 *
 * Starts a subscription checkout for the signed-in user, for their own
 * account (see the User model comment): one Stripe customer/subscription per
 * user, covering every client they own. Any signed-in customer may buy a plan
 * for themselves; someone who already has an active plan is sent to Billing
 * to change it instead of starting a second subscription.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Sign in to choose a plan." }, { status: 401 });

  let body: { planId?: string; interval?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const planId = typeof body.planId === "string" ? body.planId : "";
  const plan = findPlan(planId);
  if (!plan) {
    return NextResponse.json({ error: "Unknown plan" }, { status: 400 });
  }

  const interval: BillingInterval = body.interval === "annual" ? "annual" : "monthly";

  try {
    const { db } = await import("@/lib/db");
    const user = await db.user.findUnique({
      where: { id: session.user.id },
      select: {
        id: true, email: true, deletedAt: true, stripeCustomerId: true, stripeSubscriptionId: true,
        subscriptionStatus: true, subscriptionCurrentPeriodEnd: true
      }
    });

    if (!user || user.deletedAt) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // One subscription per account: an active plan is changed, not doubled.
    const { subscriptionIsPaid } = await import("@/lib/hosting-entitlement");
    if (user.stripeSubscriptionId && (subscriptionIsPaid(user) || user.subscriptionStatus === "past_due")) {
      return NextResponse.json(
        { error: "You already have a plan. Change it or update payment from Billing.", url: "/billing", alreadySubscribed: true },
        { status: 409 }
      );
    }

    const stripe = getStripeClient();

    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { jongoUserId: user.id }
      });
      customerId = customer.id;
      await db.user.update({ where: { id: user.id }, data: { stripeCustomerId: customerId } });
    }

    const priceId = await ensureStripePrice(plan.id, interval);

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${baseUrl()}/billing?checkout=success`,
      cancel_url: `${baseUrl()}/pricing?checkout=cancelled`,
      allow_promotion_codes: true,
      client_reference_id: user.id,
      subscription_data: {
        metadata: { jongoUserId: user.id, jongoPlanId: plan.id, jongoBillingInterval: interval }
      },
      metadata: { jongoUserId: user.id, jongoPlanId: plan.id, jongoBillingInterval: interval }
    });

    if (!checkoutSession.url) {
      return NextResponse.json({ error: "Stripe did not return a checkout URL" }, { status: 502 });
    }

    return NextResponse.json({ url: checkoutSession.url });
  } catch (error) {
    // Stripe's own message can name keys or ids; log it, show plain words.
    console.error("[billing/checkout] error:", error);
    return NextResponse.json({ error: "Checkout couldn't be started right now. Try again in a minute." }, { status: 500 });
  }
}
