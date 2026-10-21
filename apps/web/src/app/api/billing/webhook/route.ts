import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripeClient } from "@/lib/stripe";
import { applySubscriptionEvent } from "@/lib/billing/subscription-events";

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

  // Bound actual streamed bytes, not the caller-controlled Content-Length.
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    if (reader) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 1024 * 1024) {
          await reader.cancel();
          return NextResponse.json({ error: "Webhook body too large" }, { status: 413 });
        }
        chunks.push(value);
      }
    }
  } catch {
    return NextResponse.json({ error: "Invalid webhook body" }, { status: 400 });
  } finally {
    reader?.releaseLock();
  }
  const rawBody = Buffer.concat(chunks);
  const signature = req.headers.get("stripe-signature");

  let event: Stripe.Event;
  try {
    const stripe = getStripeClient();
    event = stripe.webhooks.constructEvent(rawBody, signature ?? "", webhookSecret);
  } catch {
    // SDK errors can contain the complete unsigned payload and signature header.
    console.warn("[billing/webhook] signature_verification_failed");
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;

        // Domain orders (lib/domain-orders.ts). Payment is recorded here; the
        // Namecheap order runs after the reply, because a registrar call can
        // outlast Stripe's webhook timeout and a timed-out delivery is retried
        // for days. The hourly reconcile picks up anything this misses.
        if (session.metadata?.jongoKind === "domain") {
          const { fulfilDomainCharge, recordDomainPayment } = await import("@/lib/domain-orders");
          const chargeId = await recordDomainPayment(session as never);
          if (chargeId) {
            void fulfilDomainCharge(chargeId).catch(() =>
              console.error("[billing/webhook] domain_fulfillment_failed")
            );
          }
          break;
        }

        if (session.mode !== "subscription" || !session.subscription) break;
        await applySubscriptionEvent(event);
        break;
      }

      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        await applySubscriptionEvent(event);
        break;
      }

      case "checkout.session.expired": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.metadata?.jongoKind === "domain") {
          const { handleDomainCheckoutExpired } = await import("@/lib/domain-orders");
          await handleDomainCheckoutExpired(session as never);
        }
        break;
      }

      default:
        break;
    }
  } catch {
    // Provider/DB errors may also carry request, response or private metadata.
    console.error("[billing/webhook] event_processing_failed");
    return NextResponse.json({ error: "Failed to process event" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
