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
 * Starts (or restarts) a subscription checkout for the signed-in user. The
 * subscription is per-account (see the User model comment): one Stripe
 * customer/subscription per user, no matter how many client organizations
 * they run under it.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
      select: { id: true, email: true, stripeCustomerId: true }
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
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
      success_url: `${baseUrl()}/dashboard?checkout=success`,
      cancel_url: `${baseUrl()}/pricing?checkout=cancelled`,
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
    console.error("[billing/checkout] error:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
