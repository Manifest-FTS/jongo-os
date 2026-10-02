/**
 * What a client pays for a domain: Namecheap's wholesale cost plus Jongo's
 * markup. Pure; every figure is integer cents.
 *
 * Every charge is stored with all four numbers (wholesale, markup %, markup,
 * client price) so the margin on any domain can be audited later against what
 * Namecheap actually charged, without re-deriving a markup that may since have
 * changed.
 */

import type { TermPrice, TldPriceBook } from "./namecheap-xml";

export type DomainOperation = "register" | "renew" | "transfer";

export const DEFAULT_MARKUP_PERCENT = 25;
const MAX_MARKUP_PERCENT = 300;

/** DOMAIN_MARKUP_PERCENTAGE, clamped. A typo must never price domains at cost or at 10x. */
export function readMarkupPercent(raw: string | undefined = process.env.DOMAIN_MARKUP_PERCENTAGE): number {
  const value = Number(String(raw ?? "").trim());
  if (String(raw ?? "").trim() === "" || !Number.isFinite(value) || value < 0) return DEFAULT_MARKUP_PERCENT;
  return Math.min(MAX_MARKUP_PERCENT, Math.round(value * 100) / 100);
}

/** Rounded UP to the cent: the margin is a floor, never shaved by rounding. */
export function applyMarkup(wholesaleCents: number, markupPercent: number): { markupCents: number; clientCents: number } {
  const clientCents = Math.ceil((wholesaleCents * (100 + markupPercent)) / 100 - 1e-9);
  return { markupCents: clientCents - wholesaleCents, clientCents };
}

function term(prices: TermPrice[], years: number): TermPrice | undefined {
  return prices.find((price) => price.years === years);
}

/**
 * Wholesale cost of an operation. A term's price is the total for the term and
 * the ICANN fee is per year. A transfer is always one year: the registry adds
 * that year to the domain as part of the move.
 */
export function wholesaleCents(book: TldPriceBook, operation: DomainOperation, years: number): number | null {
  const effectiveYears = operation === "transfer" ? 1 : years;
  if (!Number.isInteger(effectiveYears) || effectiveYears < 1 || effectiveYears > 10) return null;
  const price = term(book[operation], effectiveYears);
  if (!price) return null;
  return price.priceCents + price.additionalCents * effectiveYears;
}

export type DomainQuote = {
  operation: DomainOperation;
  years: number;
  wholesaleCents: number;
  markupPercent: number;
  markupCents: number;
  clientCents: number;
};

export function quoteDomain(
  book: TldPriceBook,
  operation: DomainOperation,
  years: number,
  markupPercent: number = readMarkupPercent()
): DomainQuote | null {
  const cost = wholesaleCents(book, operation, years);
  if (cost === null) return null;
  return {
    operation,
    years: operation === "transfer" ? 1 : years,
    wholesaleCents: cost,
    markupPercent,
    ...applyMarkup(cost, markupPercent)
  };
}

/** The one-year client price, for lists and search results. */
export function clientYearPrice(book: TldPriceBook | undefined, operation: DomainOperation, markupPercent?: number): number | null {
  if (!book) return null;
  return quoteDomain(book, operation, 1, markupPercent)?.clientCents ?? null;
}
