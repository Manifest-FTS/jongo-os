import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getStripeClient } from "@/lib/stripe";

export const runtime = "nodejs";

function baseUrl(): string {
  return (process.env.NEXTAUTH_URL || process.env.APP_BASE_URL || "http://localhost:3000").trim().replace(/\/+$/, "");
}

/**
 * POST /api/billing/portal — Stripe's hosted billing portal for the signed-in
 * account: change plan, update the card, see invoices, cancel. Stripe handles
 * every payment detail; Jongo never sees card data.
 */
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const { db } = await import("@/lib/db");
  const user = await db.user.findUnique({ where: { id: session.user.id }, select: { stripeCustomerId: true, deletedAt: true } });
  if (!user || user.deletedAt) return NextResponse.json({ error: "User not found" }, { status: 404 });
  if (!user.stripeCustomerId) return NextResponse.json({ error: "You don't have a plan yet. Choose one first.", url: "/pricing" }, { status: 409 });
  try {
    const portal = await getStripeClient().billingPortal.sessions.create({ customer: user.stripeCustomerId, return_url: `${baseUrl()}/billing` });
    return NextResponse.json({ url: portal.url });
  } catch (error) {
    console.error("[billing/portal] error:", error);
    return NextResponse.json({ error: "Billing management isn't available right now. Try again in a minute." }, { status: 502 });
  }
}
