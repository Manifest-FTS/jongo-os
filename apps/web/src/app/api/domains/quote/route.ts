import { NextResponse } from "next/server";
import { formatCents } from "@/lib/domain-search";
import { quoteOrder } from "@/lib/domain-orders";
import { getDomainViewer } from "@/lib/domain-access";
import type { DomainOperation } from "@/lib/domain-pricing";
import { auth } from "@/lib/auth.config";
import { financialAccessDenial } from "@/lib/rbac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/domains/quote?domain=acme.org&op=register&years=1
 *
 * Authenticated purchase quotes are financial. Public retail price/search
 * endpoints remain public and never include wholesale or private billing.
 */
export async function GET(request: Request) {
  const session = await auth();
  const denial = await financialAccessDenial(session?.user?.id);
  if (denial) return denial;
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
    ...(viewer?.isSuperAdmin
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
  }, { headers: { "Cache-Control": "no-store", Vary: "Cookie" } });
}
