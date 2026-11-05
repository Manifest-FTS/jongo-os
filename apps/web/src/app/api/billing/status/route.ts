import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/billing/status — the signed-in account's plan, for the Billing page. */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const { db } = await import("@/lib/db");
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { deletedAt: true, subscriptionPlanId: true, subscriptionInterval: true, subscriptionStatus: true, subscriptionCurrentPeriodEnd: true }
  });
  if (!user || user.deletedAt) return NextResponse.json({ error: "User not found" }, { status: 404 });
  const { subscriptionIsPaid } = await import("@/lib/hosting-entitlement");
  const { findPlan } = await import("@/lib/stripe");
  return NextResponse.json(
    {
      paid: subscriptionIsPaid(user),
      planId: user.subscriptionPlanId,
      planName: user.subscriptionPlanId ? findPlan(user.subscriptionPlanId)?.name ?? user.subscriptionPlanId : null,
      interval: user.subscriptionInterval,
      status: user.subscriptionStatus,
      currentPeriodEnd: user.subscriptionCurrentPeriodEnd
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
