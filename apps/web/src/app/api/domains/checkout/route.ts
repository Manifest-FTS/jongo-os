import { NextResponse } from "next/server";
import { startDomainCheckout } from "@/lib/domain-orders";
import { getDomainViewer } from "@/lib/domain-access";
import type { DomainOperation } from "@/lib/domain-pricing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function origin(request: Request): string {
  const configured = (process.env.NEXTAUTH_URL || process.env.APP_BASE_URL || "").trim().replace(/\/+$/, "");
  return configured || new URL(request.url).origin;
}

/**
 * POST /api/domains/checkout
 * { organizationId, domain, operation, years, contact?, eppCode? } -> { url }
 *
 * Re-quotes on the server and returns a Stripe Checkout URL. Nothing is
 * ordered at Namecheap until Stripe reports the payment (see lib/domain-orders.ts).
 */
export async function POST(request: Request) {
  const viewer = await getDomainViewer();
  if (!viewer) return NextResponse.json({ ok: false, message: "Sign in first." }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const op = body.operation;
  const operation: DomainOperation | null = op === "register" || op === "renew" || op === "transfer" ? op : null;
  if (!operation) return NextResponse.json({ ok: false, message: "Unknown operation." }, { status: 400 });
  if (typeof body.organizationId !== "string" || typeof body.domain !== "string") {
    return NextResponse.json({ ok: false, message: "Choose a client and a domain." }, { status: 400 });
  }

  const outcome = await startDomainCheckout({
    userId: viewer.userId,
    userEmail: viewer.email,
    isPlatformAdmin: viewer.isPlatformAdmin,
    organizationId: body.organizationId,
    domain: body.domain,
    operation,
    years: Number(body.years ?? 1),
    contact: body.contact,
    eppCode: typeof body.eppCode === "string" ? body.eppCode : undefined,
    origin: origin(request)
  });

  if (!outcome.ok) {
    return NextResponse.json({ ok: false, message: outcome.message, fieldErrors: outcome.fieldErrors ?? null }, { status: outcome.status });
  }
  return NextResponse.json({ ok: true, url: outcome.url, domainId: outcome.domainId });
}
