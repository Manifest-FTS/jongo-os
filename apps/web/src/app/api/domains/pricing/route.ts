import { NextResponse } from "next/server";
import { SUGGESTED_TLDS, formatCents } from "@/lib/domain-search";
import { getPricesForTlds, isPorkbunConfigured } from "@/lib/porkbun";

export const runtime = "nodejs";

/**
 * TLD prices for the public domain search.
 *
 * Safe to call freely: upstream `pricing/get` takes no credentials and is not
 * rate limited, and the result is cached in-process for an hour. This is the
 * endpoint the homepage leans on precisely BECAUSE availability checking is
 * limited to one call every ten seconds — showing ".com from $11.08" costs
 * nothing, so the page can be useful before anyone searches for anything.
 *
 * Prices are informational. The figure that gets charged is the one returned
 * by the availability check at the moment of ordering, which the registry
 * validates against the order — see lib/porkbun.ts.
 */

/** Revalidate hourly at the edge as well as in the library cache. */
export const revalidate = 3600;

export async function GET() {
  if (!isPorkbunConfigured()) {
    // Honest 503 rather than an empty price list, which would render as a row
    // of dashes and look like every TLD costs nothing.
    return NextResponse.json(
      { ok: false, reason: "not_configured", message: "Domain pricing is not connected yet." },
      { status: 503 }
    );
  }

  try {
    const prices = await getPricesForTlds(SUGGESTED_TLDS);
    return NextResponse.json(
      {
        ok: true,
        tlds: prices.map((entry) => ({
          tld: entry.tld,
          registrationCents: entry.registrationCents,
          registrationDisplay: formatCents(entry.registrationCents),
          renewalCents: entry.renewalCents,
          renewalDisplay: formatCents(entry.renewalCents),
          transferCents: entry.transferCents,
          transferDisplay: formatCents(entry.transferCents)
        }))
      },
      { headers: { "cache-control": "public, s-maxage=3600, stale-while-revalidate=86400" } }
    );
  } catch (error) {
    console.error("domain pricing: lookup failed", error);
    return NextResponse.json(
      { ok: false, reason: "upstream_error", message: "Domain pricing is unavailable right now." },
      { status: 502 }
    );
  }
}
