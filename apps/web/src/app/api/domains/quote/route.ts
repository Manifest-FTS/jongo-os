import { NextResponse } from "next/server";
import { formatCents } from "@/lib/domain-search";
import { quoteOrder } from "@/lib/domain-orders";
import { getDomainViewer } from "@/lib/domain-access";
import type { DomainOperation } from "@/lib/domain-pricing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/domains/quote?domain=acme.org&op=register&years=1
 *
 * The client price. Platform admins also get the wholesale cost and margin;
 * nobody else ever sees those.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const op = url.searchParams.get("op");
  const operation: DomainOperation = op === "renew" || op === "transfer" ? op : "register";
  const years = Number(url.searchParams.get("years") ?? 1);

  const quoted = await quoteOrder(url.searchParams.get("domain") ?? "", operation, years);
  if (!quoted.ok) return NextResponse.json({ ok: false, message: quoted.message }, { status: quoted.status });

  const viewer = await getDomainViewer();
  const { quote, domain } = quoted;
  return NextResponse.json({
    ok: true,
    domain: domain.domain,
    operation: quote.operation,
    years: quote.years,
    clientCents: quote.clientCents,
    clientDisplay: formatCents(quote.clientCents),
    ...(viewer?.isPlatformAdmin
      ? {
          admin: {
            wholesaleCents: quote.wholesaleCents,
            wholesaleDisplay: formatCents(quote.wholesaleCents),
            markupPercent: quote.markupPercent,
            markupCents: quote.markupCents,
            markupDisplay: formatCents(quote.markupCents)
          }
        }
      : {})
  });
}
