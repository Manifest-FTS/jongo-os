/**
 * Domain prices and availability as CLIENTS see them: Namecheap wholesale
 * plus Jongo's markup (lib/domain-pricing.ts). The public domain pages and
 * search read from here, never from lib/namecheap.ts directly, so no page can
 * show a wholesale price by accident.
 *
 * Availability is a three-state answer (available / taken / unknown), never a
 * boolean: when a rate limit or an outage stops us finding out, the page says
 * so instead of guessing.
 */

import { formatCents } from "@/lib/domain-search";
import { clientYearPrice, readMarkupPercent } from "@/lib/domain-pricing";
import { checkDomain, getPriceBook, getTransferPriceList, isNamecheapConfigured, namecheapMode, NamecheapError } from "@/lib/namecheap";

export function isRegistrarConfigured(): boolean {
  return isNamecheapConfigured();
}

/** Client prices for one year. */
export type TldPrice = {
  tld: string;
  registrationCents: number | null;
  renewalCents: number | null;
  transferCents: number | null;
};

/**
 * Every TLD Namecheap supports, with its client transfer price. Registration
 * and renewal are null here (they need a per-TLD lookup: getPricesForTlds).
 * Also used as the known-TLD list for parsing two-part endings like co.uk.
 */
export async function getTldPricing(): Promise<Map<string, TldPrice>> {
  const list = await getTransferPriceList();
  const markup = readMarkupPercent();
  const prices = new Map<string, TldPrice>();
  for (const [tld, book] of list) {
    prices.set(tld, { tld, registrationCents: null, renewalCents: null, transferCents: clientYearPrice(book, "transfer", markup) });
  }
  return prices;
}

export async function getPricesForTlds(tlds: readonly string[]): Promise<TldPrice[]> {
  const markup = readMarkupPercent();
  return Promise.all(
    tlds.map(async (raw) => {
      const tld = raw.toLowerCase();
      const book = await getPriceBook(tld).catch(() => null);
      return {
        tld,
        registrationCents: clientYearPrice(book ?? undefined, "register", markup),
        renewalCents: clientYearPrice(book ?? undefined, "renew", markup),
        transferCents: clientYearPrice(book ?? undefined, "transfer", markup)
      };
    })
  );
}

export type AvailabilityUnknownReason = "rate_limited" | "not_configured" | "upstream_error" | "invalid_domain";

export type DomainAvailability =
  | {
      state: "available";
      domain: string;
      priceCents: number | null;
      priceDisplay: string;
      renewalCents: number | null;
      transferCents: number | null;
      /** Premium names are priced by the registry; they are quoted on request, not sold through checkout. */
      premium: boolean;
      firstYearPromo: boolean;
      regularPriceCents: number | null;
      minDuration: number;
      sandbox: boolean;
    }
  | { state: "taken"; domain: string; transferCents: number | null; transferDisplay: string; sandbox: boolean }
  | { state: "unknown"; domain: string; reason: AvailabilityUnknownReason; message: string; retryAfterMs: number | null };

export async function checkAvailability(domain: string): Promise<DomainAvailability> {
  const target = domain.trim().toLowerCase();
  if (!target.includes(".")) {
    return { state: "unknown", domain: target, reason: "invalid_domain", message: "That does not look like a domain name.", retryAfterMs: null };
  }
  if (!isNamecheapConfigured()) {
    return { state: "unknown", domain: target, reason: "not_configured", message: "Domain search is not connected yet.", retryAfterMs: null };
  }

  try {
    const tld = target.slice(target.indexOf(".") + 1);
    const [result, book] = await Promise.all([checkDomain(target), getPriceBook(tld).catch(() => null)]);
    const sandbox = namecheapMode() === "sandbox";
    const markup = readMarkupPercent();
    if (!result) {
      return { state: "unknown", domain: target, reason: "upstream_error", message: "Namecheap did not say whether that domain is available.", retryAfterMs: null };
    }

    const transferCents = clientYearPrice(book ?? undefined, "transfer", markup);
    if (!result.available) {
      return { state: "taken", domain: target, transferCents, transferDisplay: formatCents(transferCents), sandbox };
    }

    const registrationCents = clientYearPrice(book ?? undefined, "register", markup);
    const renewalCents = clientYearPrice(book ?? undefined, "renew", markup);
    return {
      state: "available",
      domain: target,
      priceCents: registrationCents,
      priceDisplay: formatCents(registrationCents),
      renewalCents,
      transferCents,
      premium: result.premium,
      firstYearPromo: registrationCents !== null && renewalCents !== null && registrationCents < renewalCents,
      regularPriceCents: renewalCents,
      minDuration: 1,
      sandbox
    };
  } catch (error) {
    const busy = error instanceof NamecheapError && error.code === "RATE_LIMITED";
    return {
      state: "unknown",
      domain: target,
      reason: busy ? "rate_limited" : "upstream_error",
      message: busy
        ? "Too many domain searches at once. Try that again in a moment."
        : error instanceof Error && error.message
          ? error.message
          : "The domain registry could not be reached.",
      retryAfterMs: busy ? 3_000 : null
    };
  }
}
