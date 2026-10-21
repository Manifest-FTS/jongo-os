import type Stripe from "stripe";
import { getDb } from "@/lib/db";
import { getStripeClient } from "@/lib/stripe";

const terminal = (status: string | null) => status === "canceled" || status === "incomplete_expired";
const identity = (value: unknown): string | null =>
  typeof value === "string" ? value : value && typeof value === "object" && "id" in value && typeof value.id === "string" ? value.id : null;

// getDb is nullable elsewhere (mock mode); billing must never acknowledge an
// unapplied event when storage is unavailable.
async function getDbStrict() {
  const db = await getDb();
  if (!db) throw new Error("Subscription database unavailable");
  return db;
}

/** Only called AFTER raw-body signature verification. No provider calls on CMS reads. */
export async function applySubscriptionEvent(event: Stripe.Event): Promise<void> {
  const checkout = event.type === "checkout.session.completed";
  const deleted = event.type === "customer.subscription.deleted";
  const source = event.data.object as Stripe.Subscription | Stripe.Checkout.Session;
  const session = checkout ? source as Stripe.Checkout.Session : null;
  const subscriptionId = session ? identity(session.subscription) : source.id;
  const customerId = identity(source.customer);
  if (!event.id || !Number.isSafeInteger(event.created) || event.created < 0 || !subscriptionId || !customerId) {
    throw new Error("Invalid subscription event identity");
  }
  const db = await getDbStrict();
  await db.$transaction(async (tx: any) => {
    // Customer, NOT mutable metadata, resolves the account. Recheck after lock.
    const candidate = await tx.user.findUnique({ where: { stripeCustomerId: customerId }, select: { id: true } });
    if (candidate) {
      // Conflicts with the CMS owner/actor FOR SHARE lock; no draft can commit
      // on an authorization snapshot taken across this billing state change.
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${candidate.id}::uuid FOR UPDATE`;
    }
    if (await tx.stripeSubscriptionEvent.findUnique({ where: { eventId: event.id } })) return;
    const complete = async (outcome: string) => {
      await tx.stripeSubscriptionEvent.create({ data: {
        eventId: event.id, eventType: event.type, eventCreated: event.created,
        subscriptionId, customerId, userId: candidate?.id ?? null, outcome
      } });
    };
    const user = candidate ? await tx.user.findUnique({ where: { id: candidate.id } }) : null;
    const metadataUser = source.metadata?.jongoUserId;
    if (!user || user.deletedAt || user.stripeCustomerId !== customerId ||
        (metadataUser && metadataUser !== user.id) ||
        (session?.client_reference_id && session.client_reference_id !== user.id)) {
      await complete("identity_mismatch"); return;
    }
    const state = await tx.stripeSubscriptionState.findUnique({ where: { subscriptionId } });
    if (state && (state.userId !== user.id || state.customerId !== customerId)) {
      await complete("identity_mismatch"); return;
    }
    if ((!checkout && user.stripeSubscriptionId !== subscriptionId) || state?.terminal) {
      await complete("obsolete_or_terminal"); return;
    }
    const stripe = getStripeClient();
    let canonical: Stripe.Subscription;
    try {
      // Retrieval MUST stay within the owner lock: prefetched snapshots can
      // otherwise race a downgrade, including events created in the same second.
      canonical = await stripe.subscriptions.retrieve(subscriptionId, { timeout: 8_000, maxNetworkRetries: 0 });
    } catch (error) {
      const missing = error as { statusCode?: number; code?: string };
      if (!deleted || missing.statusCode !== 404 || missing.code !== "resource_missing" ||
          user.stripeSubscriptionId !== subscriptionId || source.status !== "canceled") throw error;
      canonical = source as Stripe.Subscription;
    }
    if (canonical.id !== subscriptionId || identity(canonical.customer) !== customerId ||
        (canonical.metadata?.jongoUserId && canonical.metadata.jongoUserId !== user.id)) {
      await complete("identity_mismatch"); return;
    }
    if (!Number.isFinite(canonical.current_period_end) || !Number.isSafeInteger(canonical.created) || canonical.created < 0) {
      throw new Error("Invalid canonical subscription state");
    }
    if (checkout && user.stripeSubscriptionId && user.stripeSubscriptionId !== subscriptionId) {
      const previous = await tx.stripeSubscriptionState.findUnique({ where: { subscriptionId: user.stripeSubscriptionId } });
      if (previous && (previous.userId !== user.id || previous.customerId !== customerId)) {
        await complete("identity_mismatch"); return;
      }
      let previousCreated = previous?.providerCreated;
      if (!previous?.terminal) {
        // DB status can lag Stripe cancellation. Retrieve ONLY the current
        // locked user's bound subscription, even with an existing active ledger.
        // A 404 alone is not proof of cancellation: let it retry without a
        // receipt until a signed deletion records the bound A tombstone.
        const old = await stripe.subscriptions.retrieve(user.stripeSubscriptionId, { timeout: 8_000, maxNetworkRetries: 0 });
        if (old.id !== user.stripeSubscriptionId || identity(old.customer) !== customerId ||
            (old.metadata?.jongoUserId && old.metadata.jongoUserId !== user.id)) {
          await complete("identity_mismatch"); return;
        }
        if (!terminal(old.status)) { await complete("unrelated_subscription"); return; }
        if (!Number.isSafeInteger(old.created) || old.created < 0) {
          throw new Error("Invalid previous subscription state");
        }
        previousCreated = old.created;
      }
      if (!Number.isSafeInteger(previousCreated) || previousCreated < 0 || canonical.created <= previousCreated) {
        await complete("obsolete_checkout"); return;
      }
      if (!previous?.terminal) {
        const tombstone = {
          customerId, userId: user.id, providerCreated: previousCreated,
          eventCreated: Math.max(previous?.eventCreated ?? 0, event.created), lastEventId: event.id, terminal: true
        };
        await tx.stripeSubscriptionState.upsert({ where: { subscriptionId: user.stripeSubscriptionId },
          create: { subscriptionId: user.stripeSubscriptionId, ...tombstone }, update: tombstone });
      }
    }
    const status = user.stripeSubscriptionId === subscriptionId && terminal(user.subscriptionStatus)
      ? user.subscriptionStatus : deleted ? "canceled" : canonical.status;
    await tx.user.update({ where: { id: user.id }, data: {
      stripeSubscriptionId: subscriptionId,
      subscriptionStatus: status,
      // Missing/revoked metadata must REMOVE, not retain, advanced entitlements.
      subscriptionPlanId: canonical.metadata?.jongoPlanId || null,
      subscriptionInterval: canonical.metadata?.jongoBillingInterval || null,
      subscriptionCurrentPeriodEnd: new Date(canonical.current_period_end * 1000)
    } });
    const watermark = {
      userId: user.id, customerId, providerCreated: canonical.created,
      eventCreated: Math.max(state?.eventCreated ?? 0, event.created),
      lastEventId: event.id, terminal: terminal(status)
    };
    // Event time is audit/watermark, never a reason to skip an authoritative
    // downgrade. Equal timestamps and older deliveries reconcile current state.
    await tx.stripeSubscriptionState.upsert({ where: { subscriptionId },
      create: { subscriptionId, ...watermark }, update: watermark });
    await complete("applied");
  }, { maxWait: 10_000, timeout: 20_000 });
}