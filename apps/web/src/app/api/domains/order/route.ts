import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { isPlatformAdminEmail } from "@/lib/permissions";
import { getTldPricing, isPorkbunConfigured, registerDomain, transferDomain } from "@/lib/porkbun";
import { parseDomain } from "@/lib/domain-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Placing a real domain order — registration or transfer-in.
 *
 * ## Why this is admin-only and NOT reachable from the public pages
 *
 * `domain/create` and `domain/transfer` draw on JONGO'S registrar account
 * balance. The registrar bills us; the visitor's card is not involved, because
 * this codebase has no payment integration at all. An endpoint like this
 * exposed to the public would therefore be a way for anyone to spend the
 * company's credit — a live-key faucet. The only reason the sandbox makes that
 * feel harmless is that its money is fake.
 *
 * So: authenticated platform admins only, until billing exists. The public
 * pages funnel to signup and to /contact instead. When a payment step is added,
 * the guard here is the thing to revisit — deliberately in one place.
 *
 * ## Two-phase by default
 *
 * Every order is dry-run first and only committed when the dry run agrees.
 * `dryRun: true` in the request stops after that first phase, which is what a
 * confirmation screen should call.
 *
 * ## The price is re-quoted server-side
 *
 * The client does NOT get to name the price. The cost is looked up here and
 * passed to the registrar, which independently rejects a mismatch against the
 * registry's own figure (observed: THE_COST_SUBMITTED_MUST_EQUAL_THE_COST_OF_
 * THE_DOMAIN_FOR_ITS_MINIMUM_ALLOWED_DURATION). Two independent checks on the
 * amount charged is the right number for a money path.
 */

type Body = {
  domain?: unknown;
  operation?: unknown;
  authCode?: unknown;
  dryRun?: unknown;
  /** What the customer was SHOWN. Compared against the live price, never trusted as the amount. */
  quotedCents?: unknown;
};

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, reason: "unauthorized", message: "Sign in first." }, { status: 401 });
  }

  // Platform admin only. Domain orders spend company credit and are not scoped
  // to a single site, so the per-site permission snapshot is the wrong tool —
  // this is a platform-level capability.
  //
  // Checked against the PlatformAdmin grant table (and the bootstrap email),
  // NOT a session claim: the session carries no role, so reading one would
  // silently evaluate to undefined and deny everybody.
  if (!(await isPlatformAdminEmail(session.user.email))) {
    return NextResponse.json(
      {
        ok: false,
        reason: "forbidden",
        message: "Domain orders are restricted to platform administrators."
      },
      { status: 403 }
    );
  }

  if (!isPorkbunConfigured()) {
    return NextResponse.json(
      { ok: false, reason: "not_configured", message: "The registrar is not connected." },
      { status: 503 }
    );
  }

  const body = (await request.json().catch(() => ({}))) as Body;
  const operation = body.operation === "transfer" ? "transfer" : "registration";
  const dryRun = body.dryRun === true;
  const rawDomain = typeof body.domain === "string" ? body.domain : "";

  const knownTlds = await getTldPricing().catch(() => new Map());
  const parsed = parseDomain(rawDomain, knownTlds.keys());
  if (!parsed) {
    return NextResponse.json(
      { ok: false, reason: "invalid_domain", message: "That is not a registrable domain name." },
      { status: 400 }
    );
  }

  // Re-quote from the price list rather than believing the client.
  const price = knownTlds.get(parsed.tld);
  const costCents = operation === "transfer" ? price?.transferCents : price?.registrationCents;
  if (!costCents) {
    return NextResponse.json(
      {
        ok: false,
        reason: "no_price",
        message: `We do not have a price for .${parsed.tld}. Quote it manually before ordering.`
      },
      { status: 409 }
    );
  }

  // If the customer was shown a figure, it has to match what we are about to
  // spend. A price that moved between the quote and the order is a reason to
  // stop and re-confirm, not to charge the new amount silently.
  const quoted =
    typeof body.quotedCents === "number" && Number.isSafeInteger(body.quotedCents)
      ? body.quotedCents
      : null;
  if (quoted !== null && quoted !== costCents) {
    return NextResponse.json(
      {
        ok: false,
        reason: "price_changed",
        message: "The price changed since that quote. Re-check the domain and confirm the new price.",
        quotedCents: quoted,
        currentCents: costCents
      },
      { status: 409 }
    );
  }

  const authCode = typeof body.authCode === "string" ? body.authCode : "";
  if (operation === "transfer" && !authCode.trim()) {
    return NextResponse.json(
      {
        ok: false,
        reason: "missing_auth_code",
        message: "A transfer needs the authorization code from the current registrar."
      },
      { status: 400 }
    );
  }

  const place = (isDryRun: boolean) =>
    operation === "transfer"
      ? transferDomain({ domain: parsed.domain, authCode, costCents, dryRun: isDryRun })
      : registerDomain({ domain: parsed.domain, costCents, whoisPrivacy: true, dryRun: isDryRun });

  // Phase one, always.
  const rehearsal = await place(true);
  if (!rehearsal.ok) {
    return NextResponse.json(
      {
        ok: false,
        reason: rehearsal.insufficientFunds ? "insufficient_funds" : "would_fail",
        code: rehearsal.code,
        message: rehearsal.message,
        domain: parsed.domain
      },
      { status: 409 }
    );
  }

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      domain: parsed.domain,
      operation,
      costCents,
      costDisplay: rehearsal.costDisplay,
      balanceCents: rehearsal.balanceCents,
      sandbox: rehearsal.sandbox,
      message: rehearsal.message
    });
  }

  // Phase two: the real thing.
  const result = await place(false);
  if (!result.ok) {
    console.error("domain order failed", operation, parsed.domain, result.code, result.message);
    return NextResponse.json(
      {
        ok: false,
        reason: result.insufficientFunds ? "insufficient_funds" : "order_failed",
        code: result.code,
        message: result.message,
        domain: parsed.domain
      },
      { status: 502 }
    );
  }

  console.info(
    "domain order placed",
    JSON.stringify({
      operation,
      domain: parsed.domain,
      orderId: result.orderId,
      transferId: result.transferId,
      costCents: result.costCents,
      sandbox: result.sandbox,
      actorId: session.user.id
    })
  );

  return NextResponse.json({
    ok: true,
    dryRun: false,
    domain: result.domain,
    operation,
    orderId: result.orderId,
    transferId: result.transferId,
    costCents: result.costCents,
    costDisplay: result.costDisplay,
    balanceCents: result.balanceCents,
    sandbox: result.sandbox,
    message: result.message
  });
}
