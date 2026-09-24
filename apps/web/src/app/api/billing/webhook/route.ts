import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripeClient } from "@/lib/stripe";

export const runtime = "nodejs";

/**
 * POST /api/billing/webhook
 *
 * Stripe's source of truth for subscription state. Checkout redirects the
 * browser back to /dashboard on success, but that redirect is not proof of
 * payment (the tab can close, the network can drop) — this webhook is what
 * actually persists the subscription, driven by Stripe's own retries.
 *
 * Auth is the raw-body signature, not a session: Stripe calls this directly,
 * so it has to be reachable unauthenticated at the middleware layer (see
 * middleware.ts, same arrangement as /api/webhooks/coolify).
 */
export async function POST(req: Request) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("[billing/webhook] STRIPE_WEBHOOK_SECRET is not configured.");
    return NextResponse.json({ error: "Webhook receiving is not configured." }, { status: 503 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get("stripe-signature");

  let event: Stripe.Event;
  try {
    const stripe = getStripeClient();
    event = stripe.webhooks.constructEvent(rawBody, signature ?? "", webhookSecret);
  } catch (error) {
    console.warn("[billing/webhook] signature verification failed:", error);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const { db } = await import("@/lib/db");

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.metadata?.jongoUserId || session.client_reference_id;
        if (!userId || typeof session.subscription !== "string") {
          break;
        }

        const stripe = getStripeClient();
        const subscription = await stripe.subscriptions.retrieve(session.subscription);

        await db.user.update({
          where: { id: userId },
          data: {
            stripeSubscriptionId: subscription.id,
            subscriptionPlanId: subscription.metadata?.jongoPlanId ?? session.metadata?.jongoPlanId ?? null,
            subscriptionInterval:
              subscription.metadata?.jongoBillingInterval ?? session.metadata?.jongoBillingInterval ?? null,
            subscriptionStatus: subscription.status,
            subscriptionCurrentPeriodEnd: new Date(subscription.current_period_end * 1000)
          }
        });
        break;
      }

      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const userId = subscription.metadata?.jongoUserId;

        const user = userId
          ? await db.user.findUnique({ where: { id: userId }, select: { id: true } })
          : await db.user.findFirst({
              where: { stripeCustomerId: subscription.customer as string },
              select: { id: true }
            });

        if (!user) {
          console.warn(`[billing/webhook] no user found for subscription ${subscription.id}`);
          break;
        }

        await db.user.update({
          where: { id: user.id },
          data: {
            subscriptionStatus: subscription.status,
            subscriptionCurrentPeriodEnd: new Date(subscription.current_period_end * 1000),
            ...(subscription.metadata?.jongoPlanId ? { subscriptionPlanId: subscription.metadata.jongoPlanId } : {}),
            ...(subscription.metadata?.jongoBillingInterval
              ? { subscriptionInterval: subscription.metadata.jongoBillingInterval }
              : {})
          }
        });
        break;
      }

      default:
        break;
    }
  } catch (error) {
    console.error(`[billing/webhook] failed to apply event ${event.type}:`, error);
    return NextResponse.json({ error: "Failed to process event" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
