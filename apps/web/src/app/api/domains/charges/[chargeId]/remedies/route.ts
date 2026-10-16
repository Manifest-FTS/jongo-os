import { NextResponse } from "next/server";
import { getDomainViewer } from "@/lib/domain-access";
import { canRunRemedy, DOMAIN_REMEDY_ACTIONS, isRemedyAction } from "@/lib/remedies";
import { financialAccessDenial } from "@/lib/rbac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ chargeId: string }> };

/** POST { action: "retry_domain_order" | "refund_domain_order" }: super admins only. */
export async function POST(req: Request, { params }: Params) {
  const viewer = await getDomainViewer();
  if (!viewer) return NextResponse.json({ ok: false, message: "Sign in first." }, { status: 401 });
  const denial = await financialAccessDenial(viewer.userId);
  if (denial) return denial;

  const { chargeId } = await params;
  const body: any = await req.json().catch(() => null);
  const action = body?.action;
  if (!isRemedyAction(action) || !(DOMAIN_REMEDY_ACTIONS as readonly string[]).includes(action)) {
    return NextResponse.json({ ok: false, message: "Unknown action." }, { status: 400 });
  }
  const allowed = canRunRemedy(action, { canManageBilling: viewer.isSuperAdmin });
  if (!allowed.ok) return NextResponse.json({ ok: false, message: allowed.message }, { status: 403 });

  const { retryDomainCharge, retryDomainRefund } = await import("@/lib/domain-orders");
  const outcome = action === "retry_domain_order" ? await retryDomainCharge(chargeId) : await retryDomainRefund(chargeId);
  return NextResponse.json({ ok: outcome.ok, message: outcome.message }, { status: outcome.ok ? 200 : outcome.status });
}
