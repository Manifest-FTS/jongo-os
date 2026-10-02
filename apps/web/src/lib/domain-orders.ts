/**
 * Domain orders, end to end: quote -> Stripe checkout -> paid -> Namecheap
 * order -> Cloudflare zone + nameservers.
 *
 * ## Money order
 *
 * The client pays FIRST. Nothing is ordered at Namecheap until Stripe reports
 * the checkout paid, because a Namecheap order spends Jongo's account balance.
 * If Namecheap then refuses (too little balance, the name was taken in the
 * meantime, a bad EPP code), the client is refunded automatically and the
 * charge says why. A paid order is never left silently undone.
 *
 * ## Idempotency
 *
 * Stripe retries webhooks and the hourly reconcile retries stuck orders, so a
 * charge is claimed (paid -> fulfilling) with a conditional update before any
 * registrar call; whoever loses the claim does nothing. A timeout during a
 * registration does not say whether it happened, so that case is checked
 * against Namecheap (getInfo) before it is retried, rather than ordering twice.
 */

import { getDb } from "@/lib/db";
import { getStripeClient } from "@/lib/stripe";
import { formatCents, parseDomain, type ParsedDomain } from "@/lib/domain-search";
import { quoteDomain, readMarkupPercent, type DomainOperation, type DomainQuote } from "@/lib/domain-pricing";
import { validateContact, type RegistrantContact } from "@/lib/domain-contact";
import {
  checkDomain,
  getDomainInfo,
  getPriceBook,
  getTransferPriceList,
  getTransferStatus,
  isInsufficientFunds,
  NamecheapError,
  registerDomain,
  renewDomain,
  setCustomNameservers,
  transferDomain
} from "@/lib/namecheap";
import { isTransferDead } from "@/lib/namecheap-xml";
import { applySslDefaults, ensureZone, getZone, isCloudflareConfigured } from "@/lib/cloudflare";

/* eslint-disable @typescript-eslint/no-explicit-any */

export const OPERATION_LABEL: Record<DomainOperation, string> = {
  register: "Registration",
  renew: "Renewal",
  transfer: "Transfer"
};

/** Parses with Namecheap's TLD list, so co.uk is an ending and not a subdomain. */
export async function parseOrderDomain(raw: string): Promise<ParsedDomain | null> {
  const known = await getTransferPriceList().catch(() => null);
  return parseDomain(raw.trim().toLowerCase(), known ? known.keys() : undefined);
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/** Clients the user can buy domains for: owner or admin collaborator; every client for platform admins. */
export async function getManageableOrganizations(userId: string, isPlatformAdmin: boolean): Promise<Array<{ id: string; name: string }>> {
  const db: any = await getDb();
  if (!db) return [];
  return db.organization.findMany({
    where: isPlatformAdmin
      ? { deletedAt: null }
      : {
          deletedAt: null,
          OR: [{ ownerId: userId }, { collaborators: { some: { userId, role: "admin", deletedAt: null } } }]
        },
    select: { id: true, name: true },
    orderBy: { name: "asc" }
  });
}

/** Clients whose domains the user can see. null = all (platform admin). */
export async function getVisibleOrganizationIds(userId: string, isPlatformAdmin: boolean): Promise<string[] | null> {
  if (isPlatformAdmin) return null;
  const db: any = await getDb();
  if (!db) return [];
  const rows: Array<{ id: string }> = await db.organization.findMany({
    where: { deletedAt: null, OR: [{ ownerId: userId }, { collaborators: { some: { userId, deletedAt: null } } }] },
    select: { id: true }
  });
  return rows.map((row) => row.id);
}

export async function canManageOrganization(organizationId: string, userId: string, isPlatformAdmin: boolean): Promise<boolean> {
  if (isPlatformAdmin) return true;
  return (await getManageableOrganizations(userId, false)).some((org) => org.id === organizationId);
}

// ---------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------

export type QuoteOutcome =
  | { ok: true; domain: ParsedDomain; quote: DomainQuote }
  | { ok: false; status: number; message: string };

/**
 * A server-side quote. The client never names a price: what Stripe charges is
 * always computed here, from Namecheap's current wholesale price.
 */
export async function quoteOrder(rawDomain: string, operation: DomainOperation, years: number): Promise<QuoteOutcome> {
  const domain = await parseOrderDomain(rawDomain);
  if (!domain) return { ok: false, status: 400, message: "That is not a domain name we can order, like acme.org." };
  if (!Number.isInteger(years) || years < 1 || years > 10) return { ok: false, status: 400, message: "Choose 1 to 10 years." };

  const book = await getPriceBook(domain.tld).catch(() => null);
  if (!book) return { ok: false, status: 502, message: `We could not get a price for .${domain.tld} right now. Try again shortly.` };
  const quote = quoteDomain(book, operation, years, readMarkupPercent());
  if (!quote) {
    return { ok: false, status: 400, message: `.${domain.tld} cannot be ${operation === "transfer" ? "transferred" : `${operation}ed for ${years} year${years === 1 ? "" : "s"}`} here.` };
  }
  return { ok: true, domain, quote };
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

export type CheckoutInput = {
  userId: string;
  userEmail: string;
  isPlatformAdmin: boolean;
  organizationId: string;
  domain: string;
  operation: DomainOperation;
  years: number;
  contact?: unknown;
  eppCode?: string;
  origin: string;
};

export type CheckoutOutcome =
  | { ok: true; url: string; domainId: string; chargeId: string; quote: DomainQuote }
  | { ok: false; status: number; message: string; fieldErrors?: Record<string, string> };

export async function startDomainCheckout(input: CheckoutInput): Promise<CheckoutOutcome> {
  const db: any = await getDb();
  if (!db) return { ok: false, status: 503, message: "The database is unavailable." };

  if (!(await canManageOrganization(input.organizationId, input.userId, input.isPlatformAdmin))) {
    return { ok: false, status: 403, message: "Only a client's admins can buy domains for it." };
  }

  const quoted = await quoteOrder(input.domain, input.operation, input.years);
  if (!quoted.ok) return quoted;
  const { domain, quote } = quoted;

  const existing = await db.domain.findUnique({ where: { name: domain.domain } });

  let contact: RegistrantContact | null = null;
  let eppCode: string | null = null;

  if (input.operation === "renew") {
    if (!existing || existing.deletedAt || existing.organizationId !== input.organizationId) {
      return { ok: false, status: 404, message: "That domain is not one of this client's domains." };
    }
    if (!["active", "expired"].includes(existing.status)) {
      return { ok: false, status: 409, message: "Only a registered domain can be renewed." };
    }
  } else {
    if (existing && !existing.deletedAt && !["failed", "pending_payment"].includes(existing.status)) {
      return { ok: false, status: 409, message: `${domain.domain} is already managed in Jongo.` };
    }
    if (existing && !existing.deletedAt && existing.organizationId !== input.organizationId && existing.status !== "failed") {
      return { ok: false, status: 409, message: `${domain.domain} has an order open for another client.` };
    }

    const check = await checkDomain(domain.domain, { fresh: true, patient: true }).catch(() => null);
    if (!check) return { ok: false, status: 502, message: "We could not check that domain with the registry just now. Try again shortly." };

    if (input.operation === "register") {
      if (!check.available) return { ok: false, status: 409, message: `${domain.domain} is already registered. If it is yours, transfer it instead.` };
      if (check.premium) return { ok: false, status: 409, message: `${domain.domain} is a premium name priced by the registry. Contact us for a quote.` };
      const validated = validateContact(input.contact);
      if (!validated.ok) {
        return { ok: false, status: 400, message: "Check the owner details.", fieldErrors: validated.errors as Record<string, string> };
      }
      contact = validated.contact;
    } else {
      if (check.available) return { ok: false, status: 409, message: `${domain.domain} is not registered anywhere, so there is nothing to transfer. Register it instead.` };
      eppCode = (input.eppCode ?? "").trim();
      if (eppCode.length < 4 || eppCode.length > 64) {
        return { ok: false, status: 400, message: "Enter the transfer authorization (EPP) code from your current registrar.", fieldErrors: { eppCode: "Required." } };
      }
    }
  }

  const domainRow = existing
    ? input.operation === "renew"
      ? existing
      : await db.domain.update({
          where: { id: existing.id },
          data: { organizationId: input.organizationId, status: "pending_payment", lastError: null, deletedAt: null }
        })
    : await db.domain.create({
        data: { organizationId: input.organizationId, name: domain.domain, status: "pending_payment", createdById: input.userId }
      });

  const charge = await db.domainCharge.create({
    data: {
      domainId: domainRow.id,
      operation: input.operation,
      years: quote.years,
      status: "pending_payment",
      wholesaleCents: quote.wholesaleCents,
      markupPercent: quote.markupPercent,
      markupCents: quote.markupCents,
      clientCents: quote.clientCents,
      registrantContact: contact ?? undefined,
      eppCode,
      createdById: input.userId
    }
  });

  try {
    const stripe = getStripeClient();
    const user = await db.user.findUnique({ where: { id: input.userId }, select: { stripeCustomerId: true } });
    let customerId: string | null = user?.stripeCustomerId ?? null;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: input.userEmail, metadata: { jongoUserId: input.userId } });
      customerId = customer.id;
      await db.user.update({ where: { id: input.userId }, data: { stripeCustomerId: customerId } });
    }

    const term = quote.operation === "transfer" ? "includes 1 year" : `${quote.years} year${quote.years === 1 ? "" : "s"}`;
    const metadata = { jongoKind: "domain", domainChargeId: charge.id, domain: domain.domain, operation: quote.operation };
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer: customerId,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: quote.clientCents,
            product_data: {
              name: `${domain.domain} — ${OPERATION_LABEL[quote.operation]}`,
              description: `${term}. WHOIS privacy included.`
            }
          }
        }
      ],
      metadata,
      payment_intent_data: { metadata, description: `${OPERATION_LABEL[quote.operation]} of ${domain.domain}` },
      client_reference_id: input.userId,
      // Prices can move; a quote is good for an hour.
      expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
      success_url: `${input.origin}/my-domains/${domainRow.id}?checkout=success`,
      cancel_url: `${input.origin}/my-domains/new?op=${quote.operation}&domain=${encodeURIComponent(domain.domain)}&checkout=cancelled`
    });
    if (!session.url) throw new Error("Stripe did not return a checkout URL.");

    await db.domainCharge.update({ where: { id: charge.id }, data: { stripeCheckoutSessionId: session.id } });
    return { ok: true, url: session.url, domainId: domainRow.id, chargeId: charge.id, quote };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not start checkout.";
    await db.domainCharge.update({ where: { id: charge.id }, data: { status: "failed", error: message, registrantContact: null, eppCode: null } });
    return { ok: false, status: 502, message: `Payment could not be started: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// Stripe webhook entry points
// ---------------------------------------------------------------------------

/**
 * Records the payment. Returns the charge to fulfil, or null when there is
 * nothing to do (not a domain checkout, not paid, already recorded).
 */
export async function recordDomainPayment(session: {
  id: string;
  payment_status?: string | null;
  payment_intent?: unknown;
  metadata?: Record<string, string> | null;
}): Promise<string | null> {
  const chargeId = session.metadata?.domainChargeId;
  if (!chargeId || session.payment_status !== "paid") return null;
  const db: any = await getDb();
  if (!db) throw new Error("database unavailable");

  const paymentIntent =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent as { id?: string } | null)?.id ?? null;
  // Also from "expired": a session can be paid in its last seconds while the
  // reconcile is expiring it.
  const updated = await db.domainCharge.updateMany({
    where: { id: chargeId, status: { in: ["pending_payment", "expired"] } },
    data: { status: "paid", paidAt: new Date(), stripePaymentIntentId: paymentIntent }
  });
  return updated.count === 1 ? chargeId : null;
}

export async function handleDomainCheckoutExpired(session: { metadata?: Record<string, string> | null }): Promise<void> {
  const chargeId = session.metadata?.domainChargeId;
  if (!chargeId) return;
  const db: any = await getDb();
  if (!db) return;
  await db.domainCharge.updateMany({
    where: { id: chargeId, status: "pending_payment" },
    data: { status: "expired", registrantContact: null, eppCode: null }
  });
}

// ---------------------------------------------------------------------------
// Fulfilment
// ---------------------------------------------------------------------------

async function refund(db: any, charge: any, reason: string): Promise<void> {
  let refundId: string | null = null;
  let refundError: string | null = null;
  if (charge.stripePaymentIntentId) {
    try {
      const result = await getStripeClient().refunds.create({
        payment_intent: charge.stripePaymentIntentId,
        reason: "requested_by_customer",
        metadata: { jongoKind: "domain", domainChargeId: charge.id }
      });
      refundId = result.id;
    } catch (error) {
      refundError = error instanceof Error ? error.message : "refund failed";
    }
  } else {
    refundError = "no payment intent recorded";
  }
  await db.domainCharge.update({
    where: { id: charge.id },
    data: {
      status: refundId ? "refunded" : "failed",
      stripeRefundId: refundId,
      error: refundId ? `${reason} The payment was refunded.` : `${reason} Refund NOT issued (${refundError}); refund it by hand in Stripe.`,
      registrantContact: null,
      eppCode: null
    }
  });
  if (!refundId) console.error(`[domains] charge ${charge.id}: refund failed: ${refundError}`);
}

function describeRegistrarFailure(error: unknown, operation: DomainOperation): string {
  if (isInsufficientFunds(error)) {
    return `The ${operation} could not be placed: the registrar account needs topping up.`;
  }
  const message = error instanceof Error ? error.message : "unknown error";
  return `The registrar refused the ${operation}: ${message}.`;
}

export async function fulfilDomainCharge(chargeId: string): Promise<void> {
  const db: any = await getDb();
  if (!db) throw new Error("database unavailable");

  const claimed = await db.domainCharge.updateMany({ where: { id: chargeId, status: "paid" }, data: { status: "fulfilling" } });
  if (claimed.count !== 1) return;

  const charge = await db.domainCharge.findUnique({ where: { id: chargeId }, include: { domain: true } });
  const domain = await parseOrderDomain(charge.domain.name);
  const operation = charge.operation as DomainOperation;
  if (!domain) {
    await refund(db, charge, `${charge.domain.name} could not be parsed.`);
    await db.domain.update({ where: { id: charge.domainId }, data: { status: operation === "renew" ? charge.domain.status : "failed" } });
    return;
  }

  try {
    if (operation === "register") {
      await db.domain.update({ where: { id: charge.domainId }, data: { status: "registering" } });
      const result = await registerDomain({ domain, years: charge.years, contact: charge.registrantContact as RegistrantContact });
      const info = await getDomainInfo(domain.domain).catch(() => null);
      await db.domain.update({
        where: { id: charge.domainId },
        data: {
          status: "active",
          registrarDomainId: result.domainId,
          expiresAt: info?.expiresAt ?? new Date(Date.now() + charge.years * 365 * 86_400_000),
          lastError: null
        }
      });
      await markFulfilled(db, charge.id, result);
      await provisionDomainDns(charge.domainId);
    } else if (operation === "renew") {
      const result = await renewDomain({ domain, years: charge.years });
      const info = result.expiresAt ? null : await getDomainInfo(domain.domain).catch(() => null);
      await db.domain.update({
        where: { id: charge.domainId },
        data: { status: "active", expiresAt: result.expiresAt ?? info?.expiresAt ?? undefined, lastError: null }
      });
      await markFulfilled(db, charge.id, result);
    } else {
      const result = await transferDomain({ domain, eppCode: charge.eppCode ?? "" });
      await db.domain.update({
        where: { id: charge.domainId },
        data: { status: "transfer_pending", transferId: result.transferId, lastError: null }
      });
      await markFulfilled(db, charge.id, result);
    }
  } catch (error) {
    const transient = error instanceof NamecheapError && error.transient;
    if (transient) {
      // Did it happen anyway? For a registration, ask the registrar before
      // trying again: ordering twice is the one thing this must never do.
      if (operation === "register") {
        const info = await getDomainInfo(domain.domain).catch(() => null);
        if (info?.isOwner) {
          await db.domain.update({ where: { id: charge.domainId }, data: { status: "active", expiresAt: info.expiresAt, lastError: null } });
          await markFulfilled(db, charge.id, null);
          await provisionDomainDns(charge.domainId);
          return;
        }
      }
      await db.domainCharge.update({
        where: { id: charge.id },
        data: { status: "paid", error: `Waiting to retry: ${error instanceof Error ? error.message : "registrar unreachable"}` }
      });
      return;
    }

    const reason = describeRegistrarFailure(error, operation);
    await refund(db, charge, reason);
    await db.domain.update({
      where: { id: charge.domainId },
      data: { status: operation === "renew" ? charge.domain.status : "failed", lastError: reason }
    });
  }
}

async function markFulfilled(db: any, chargeId: string, result: { chargedCents: number | null; orderId: string | null; transactionId: string | null } | null) {
  await db.domainCharge.update({
    where: { id: chargeId },
    data: {
      status: "fulfilled",
      fulfilledAt: new Date(),
      registrarChargedCents: result?.chargedCents ?? null,
      registrarOrderId: result?.orderId ?? null,
      registrarTransactionId: result?.transactionId ?? null,
      error: null,
      registrantContact: null,
      eppCode: null
    }
  });
}

// ---------------------------------------------------------------------------
// DNS: Cloudflare zone + nameservers at Namecheap
// ---------------------------------------------------------------------------

export async function provisionDomainDns(domainId: string): Promise<void> {
  const db: any = await getDb();
  if (!db) return;
  const row = await db.domain.findUnique({ where: { id: domainId } });
  if (!row || row.status !== "active") return;

  if (!isCloudflareConfigured()) {
    await db.domain.update({ where: { id: domainId }, data: { dnsStatus: "pending", lastError: "DNS is waiting for Cloudflare to be connected." } });
    return;
  }

  try {
    const domain = await parseOrderDomain(row.name);
    if (!domain) throw new Error("unparseable domain");
    const zone = await ensureZone(row.name);
    await applySslDefaults(zone.id).catch((error) => console.warn(`[domains] SSL defaults for ${row.name}:`, error));
    const nameservers = zone.name_servers.map((ns) => ns.toLowerCase());
    const current = row.nameservers.join(",") === nameservers.join(",");
    if (!current) await setCustomNameservers(domain, nameservers);
    await db.domain.update({
      where: { id: domainId },
      data: {
        cloudflareZoneId: zone.id,
        nameservers,
        dnsStatus: zone.status === "active" ? "active" : "pending",
        lastError: null
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "DNS setup failed";
    await db.domain.update({ where: { id: domainId }, data: { dnsStatus: "error", lastError: `DNS setup failed: ${message}` } });
  }
}

// ---------------------------------------------------------------------------
// Hourly self-repair (called from the backup-reconcile pass)
// ---------------------------------------------------------------------------

export type DomainReconcileResult = {
  retried: number;
  recovered: number;
  transfersCompleted: number;
  transfersFailed: number;
  dnsProvisioned: number;
  expiriesRefreshed: number;
  checkoutsExpired: number;
};

export async function reconcileDomains(): Promise<DomainReconcileResult> {
  const result: DomainReconcileResult = { retried: 0, recovered: 0, transfersCompleted: 0, transfersFailed: 0, dnsProvisioned: 0, expiriesRefreshed: 0, checkoutsExpired: 0 };
  const db: any = await getDb();
  if (!db) return result;
  const now = Date.now();

  // Abandoned checkouts: Stripe sessions expire after an hour.
  const abandoned = await db.domainCharge.updateMany({
    where: { status: "pending_payment", createdAt: { lt: new Date(now - 2 * 60 * 60_000) } },
    data: { status: "expired", registrantContact: null, eppCode: null }
  });
  result.checkoutsExpired = abandoned.count;

  // Paid but not placed (registrar was unreachable). Retried for a day, then refunded.
  for (const charge of await db.domainCharge.findMany({ where: { status: "paid", paidAt: { lt: new Date(now - 2 * 60_000) } }, take: 10 })) {
    if (charge.paidAt && now - new Date(charge.paidAt).getTime() > 24 * 60 * 60_000) {
      await db.domainCharge.update({ where: { id: charge.id }, data: { status: "fulfilling" } });
      await refund(db, charge, "The registrar could not be reached for a day.");
      await db.domain.update({ where: { id: charge.domainId }, data: { status: charge.operation === "renew" ? undefined : "failed" } });
      continue;
    }
    await fulfilDomainCharge(charge.id);
    result.retried += 1;
  }

  // Stuck mid-order (the process died): find out from Namecheap what happened.
  for (const charge of await db.domainCharge.findMany({
    where: { status: "fulfilling", updatedAt: { lt: new Date(now - 30 * 60_000) } },
    include: { domain: true },
    take: 5
  })) {
    const info = await getDomainInfo(charge.domain.name).catch(() => null);
    if (charge.operation === "register" && info?.isOwner) {
      await db.domain.update({ where: { id: charge.domainId }, data: { status: "active", expiresAt: info.expiresAt } });
      await markFulfilled(db, charge.id, null);
      result.recovered += 1;
    } else if (charge.operation === "register") {
      await db.domainCharge.update({ where: { id: charge.id }, data: { status: "paid" } });
    } else {
      // Renewals and transfers cannot be told apart from Namecheap's state alone.
      await db.domainCharge.update({ where: { id: charge.id }, data: { error: "Stuck mid-order: check this one by hand in Namecheap before retrying." } });
    }
  }

  // Transfers: done when the domain appears in the account.
  for (const row of await db.domain.findMany({ where: { status: "transfer_pending", deletedAt: null }, take: 10 })) {
    const info = await getDomainInfo(row.name).catch(() => null);
    if (info?.isOwner) {
      await db.domain.update({ where: { id: row.id }, data: { status: "active", expiresAt: info.expiresAt, lastError: null } });
      await provisionDomainDns(row.id);
      result.transfersCompleted += 1;
      continue;
    }
    if (row.transferId) {
      const status = await getTransferStatus(row.transferId).catch(() => null);
      if (status && isTransferDead(status)) {
        const reason = `The transfer stopped at the registry: ${status.status}.`;
        await db.domain.update({ where: { id: row.id }, data: { status: "failed", lastError: reason } });
        const charge = await db.domainCharge.findFirst({ where: { domainId: row.id, operation: "transfer", status: "fulfilled" }, orderBy: { createdAt: "desc" } });
        if (charge) await refund(db, charge, reason);
        result.transfersFailed += 1;
      }
    }
  }

  // DNS not set up yet, or waiting for Cloudflare to see the new nameservers.
  for (const row of await db.domain.findMany({
    where: { status: "active", deletedAt: null, OR: [{ cloudflareZoneId: null }, { dnsStatus: { in: ["pending", "error"] } }] },
    take: 10
  })) {
    if (!row.cloudflareZoneId || row.dnsStatus === "error") {
      await provisionDomainDns(row.id);
      result.dnsProvisioned += 1;
    } else if (isCloudflareConfigured()) {
      const zone = await getZone(row.cloudflareZoneId).catch(() => null);
      if (zone?.status === "active") await db.domain.update({ where: { id: row.id }, data: { dnsStatus: "active" } });
    }
  }

  // Expiry dates drift (renewed elsewhere, auto-renew at Namecheap): refresh a few a day.
  for (const row of await db.domain.findMany({
    where: { status: { in: ["active", "expired"] }, deletedAt: null, updatedAt: { lt: new Date(now - 24 * 60 * 60_000) } },
    orderBy: { updatedAt: "asc" },
    take: 5
  })) {
    const info = await getDomainInfo(row.name).catch(() => null);
    if (!info) continue;
    const expired = info.expiresAt ? info.expiresAt.getTime() < now : false;
    await db.domain.update({ where: { id: row.id }, data: { expiresAt: info.expiresAt, status: expired ? "expired" : "active" } });
    result.expiriesRefreshed += 1;
  }

  return result;
}

export function describeCharge(charge: { operation: string; years: number; clientCents: number }): string {
  const op = OPERATION_LABEL[charge.operation as DomainOperation] ?? charge.operation;
  return `${op} · ${charge.operation === "transfer" ? "1 year" : `${charge.years} yr`} · ${formatCents(charge.clientCents)}`;
}
