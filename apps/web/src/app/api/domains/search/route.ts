import { NextResponse } from "next/server";
import { RateLimiter } from "@/lib/contact-request";
import { formatCents, normalizeDomainQuery, parseDomain } from "@/lib/domain-search";
import { checkAvailability, getTldPricing, isRegistrarConfigured } from "@/lib/registrar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Domain availability for the public search box.
 *
 * ## Why this endpoint checks exactly one domain
 *
 * Namecheap allows about 50 API calls a minute for the whole account, shared
 * with orders and renewals. A "search" that fanned out over six TLDs would use
 * that budget six times as fast and lock other visitors out. So
 * the contract here is one domain per request: the client asks about the exact
 * name someone typed, and the UI offers the other TLDs as PRICES (free, from
 * /api/domains/pricing) with a per-row "check" button rather than checking
 * them all up front.
 *
 * ## Two rate limits, doing different jobs
 *
 * - Per IP, here: stops one visitor (or a script) consuming the shared budget.
 *   Generous enough for a person trying a few names.
 * - Global, in lib/registrar.ts: the gate and cache that keep us inside the
 *   upstream limit no matter how many visitors there are.
 *
 * A refusal from either is reported as `unknown`/`rate_limited` with a retry
 * hint. It is never reported as "available" — sending someone to a checkout
 * for a domain we did not actually check is the failure this whole module is
 * arranged to prevent.
 */

// Twelve searches per five minutes per address: enough to try a handful of
// names, far too few to drain a limit of six checks a minute.
const limiter = new RateLimiter(12, 5 * 60 * 1000);

function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  const first = forwarded.split(",")[0]?.trim();
  return (
    first ||
    request.headers.get("cf-connecting-ip")?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { domain?: unknown };
  const raw = typeof body.domain === "string" ? body.domain : "";
  const normalized = normalizeDomainQuery(raw);

  if (!normalized) {
    return NextResponse.json(
      { ok: false, reason: "invalid_domain", message: "Type a domain name to check." },
      { status: 400 }
    );
  }

  if (!isRegistrarConfigured()) {
    return NextResponse.json(
      { ok: false, reason: "not_configured", message: "Domain search is not connected yet." },
      { status: 503 }
    );
  }

  // Validate the shape BEFORE the rate limit and before the upstream call, so
  // a typo neither costs the caller a token nor the account a check.
  const knownTlds = await getTldPricing().catch(() => new Map());
  const parsed = parseDomain(normalized, knownTlds.keys());
  if (!parsed) {
    return NextResponse.json(
      {
        ok: false,
        reason: "invalid_domain",
        message: normalized.includes(".")
          ? "That looks like a subdomain or an invalid name. Try the domain itself, like northfield.com."
          : "Add an ending, like .com — or pick one of the suggestions."
      },
      { status: 400 }
    );
  }

  const gate = limiter.check(clientKey(request));
  if (!gate.allowed) {
    return NextResponse.json(
      {
        ok: false,
        reason: "rate_limited",
        message: "That is a lot of searches in a short time. Give it a minute.",
        retryAfterSeconds: gate.retryAfterSeconds
      },
      { status: 429, headers: { "Retry-After": String(gate.retryAfterSeconds) } }
    );
  }

  const result = await checkAvailability(parsed.domain);

  if (result.state === "unknown") {
    const retryAfterSeconds = result.retryAfterMs
      ? Math.max(1, Math.ceil(result.retryAfterMs / 1000))
      : null;
    return NextResponse.json(
      {
        ok: false,
        domain: parsed.domain,
        reason: result.reason,
        message: result.message,
        retryAfterSeconds
      },
      {
        // 503, not 502: Cloudflare replaces an origin 502 body with its own page, hiding this message.
        status: result.reason === "rate_limited" ? 429 : 503,
        ...(retryAfterSeconds ? { headers: { "Retry-After": String(retryAfterSeconds) } } : {})
      }
    );
  }

  if (result.state === "taken") {
    return NextResponse.json({
      ok: true,
      domain: result.domain,
      available: false,
      transferCents: result.transferCents,
      transferDisplay: result.transferDisplay,
      sandbox: result.sandbox
    });
  }

  return NextResponse.json({
    ok: true,
    domain: result.domain,
    available: true,
    priceCents: result.priceCents,
    priceDisplay: result.priceDisplay,
    renewalCents: result.renewalCents,
    renewalDisplay: formatCents(result.renewalCents),
    transferCents: result.transferCents,
    premium: result.premium,
    firstYearPromo: result.firstYearPromo,
    regularPriceDisplay: formatCents(result.regularPriceCents),
    minDuration: result.minDuration,
    sandbox: result.sandbox
  });
}
