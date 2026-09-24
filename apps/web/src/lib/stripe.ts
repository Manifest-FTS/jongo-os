import Stripe from "stripe";
import { ALL_PLANS, type TierPlan } from "@/lib/public-plans";

export type BillingInterval = "monthly" | "annual";

let cachedClient: Stripe | null = null;

/**
 * Lazily constructed so a build/import with no STRIPE_SECRET_KEY set (any
 * environment that hasn't wired billing up yet) doesn't crash at module load —
 * only a request that actually needs Stripe does.
 */
export function getStripeClient(): Stripe {
  if (cachedClient) {
    return cachedClient;
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY is not configured.");
  }

  cachedClient = new Stripe(secretKey, {
    apiVersion: "2025-02-24.acacia"
  });
  return cachedClient;
}

export function findPlan(planId: string): TierPlan | undefined {
  return ALL_PLANS.find((plan) => plan.id === planId);
}

/** Deterministic so re-running this never creates a duplicate. */
function productIdFor(plan: TierPlan): string {
  return `jongo_plan_${plan.id}`;
}

function lookupKeyFor(plan: TierPlan, interval: BillingInterval): string {
  return `jongo_${plan.id}_${interval}`;
}

/**
 * Finds the Stripe Price for a plan/interval, creating the Product and Price
 * on first use if they don't exist yet. This is the whole point of it: the
 * plans already live in one place (lib/public-plans.ts), so nobody should have
 * to also go re-type them into the Stripe dashboard and keep the two in sync
 * by hand.
 */
export async function ensureStripePrice(planId: string, interval: BillingInterval): Promise<string> {
  const plan = findPlan(planId);
  if (!plan) {
    throw new Error(`Unknown plan id: ${planId}`);
  }

  const stripe = getStripeClient();
  const lookupKey = lookupKeyFor(plan, interval);

  const existing = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 });
  if (existing.data[0]) {
    return existing.data[0].id;
  }

  const productId = productIdFor(plan);
  let product: Stripe.Product;
  try {
    product = await stripe.products.retrieve(productId);
  } catch {
    product = await stripe.products.create({
      id: productId,
      name: plan.name,
      description: plan.blurb,
      metadata: { jongoPlanId: plan.id, jongoPlanCategory: plan.category }
    });
  }

  const unitAmount = interval === "monthly" ? plan.monthlyPrice : plan.annualPrice;

  const price = await stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: unitAmount * 100,
    recurring: { interval: interval === "monthly" ? "month" : "year" },
    lookup_key: lookupKey,
    metadata: { jongoPlanId: plan.id, jongoBillingInterval: interval }
  });

  return price.id;
}
