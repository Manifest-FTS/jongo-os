/**
 * Turning what someone types into a domain we can actually look up.
 *
 * This module is deliberately pure — no network, no env, no clock. Everything
 * here is the part that has to be RIGHT rather than the part that has to be
 * fast, and the money conversion in particular is worth testing properly:
 * Porkbun's endpoints disagree about units, and getting that wrong charges a
 * customer the wrong amount.
 *
 * ## The unit trap
 *
 * `domain/checkDomain` and `pricing/get` report prices as DECIMAL STRINGS
 * ("11.08"). `domain/create` and `domain/transfer` take a `cost` in INTEGER
 * CENTS (1108) and, on the live API, reject the call when it disagrees with
 * what the registry says. So every price crosses a unit boundary between
 * looking one up and acting on it, and `11.08 * 100` is 1108.0000000000002 in
 * IEEE754. `toCents` exists so that conversion happens in exactly one place,
 * under test, instead of inline at three call sites.
 */

/** A domain split into the part someone chose and the part they picked from. */
export type ParsedDomain = {
  /** "northfield" in "northfield.co.uk". Always lower case. */
  label: string;
  /** "co.uk" in "northfield.co.uk". No leading dot. Always lower case. */
  tld: string;
  /** The reassembled "label.tld", which is what the API wants. */
  domain: string;
};

/**
 * The TLDs offered when someone types a bare word with no dot.
 *
 * Kept short on purpose. Each one the UI offers to CHECK costs a call against
 * a limit of one per ten seconds account-wide (see lib/porkbun.ts), so a
 * generous list here is not generosity — it is a queue. Prices for these come
 * from the unthrottled pricing endpoint, so showing them is free; checking
 * them is not.
 */
export const SUGGESTED_TLDS = ["com", "co", "net", "org", "io", "dev"] as const;

/** Hostname label rule: alphanumeric and inner hyphens, 1–63 characters. */
const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Clean up a raw search box value.
 *
 * People paste "https://www.Example.com/pricing?x=1" into a domain search far
 * more often than they type "example.com", so this strips a scheme, a userinfo
 * segment, a port, a path, a query and a trailing dot. It does NOT strip a
 * leading "www." — "www.example.com" is a real, registrable-looking string and
 * silently searching for something the user did not type is worse than telling
 * them it is not what they meant.
 */
export function normalizeDomainQuery(raw: string): string {
  let value = (raw || "").trim().toLowerCase();
  if (!value) return "";

  // Scheme, then anything before an @ (userinfo), then the first path segment.
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const at = value.lastIndexOf("@");
  if (at !== -1) value = value.slice(at + 1);
  value = value.split(/[/?#]/)[0] ?? "";
  // Port.
  value = value.replace(/:\d+$/, "");
  // A fully-qualified name's trailing root dot.
  value = value.replace(/\.$/, "");

  return value.trim();
}

/**
 * Split a normalized query into label and TLD.
 *
 * Returns null for anything that is not a plausible registrable name, so
 * callers never hand garbage to the API and burn a rate-limited check on it.
 * This does not consult the public suffix list: "northfield.co.uk" is treated
 * as label "northfield" + TLD "co.uk" by matching against the TLDs the
 * registrar actually sells, which the caller passes in. With no list to match
 * against it falls back to the last label, which is right for the common case
 * and wrong for a handful of two-part suffixes — hence the parameter.
 */
export function parseDomain(query: string, knownTlds?: Iterable<string>): ParsedDomain | null {
  const value = normalizeDomainQuery(query);
  if (!value || !value.includes(".")) return null;
  if (value.length > 253) return null;

  const parts = value.split(".");
  if (parts.some((part) => part.length === 0)) return null;

  // Prefer the longest known suffix, so "co.uk" wins over "uk".
  let tld: string | null = null;
  if (knownTlds) {
    const known = new Set(Array.from(knownTlds, (entry) => entry.toLowerCase()));
    for (let start = 1; start < parts.length; start += 1) {
      const candidate = parts.slice(start).join(".");
      if (known.has(candidate)) {
        tld = candidate;
        break;
      }
    }
  }
  if (!tld) tld = parts[parts.length - 1] ?? "";

  const labelParts = parts.slice(0, parts.length - tld.split(".").length);
  const label = labelParts.join(".");
  if (!label || !tld) return null;

  // Every label must be a valid hostname label. A dotted label ("a.b.example
  // .com") is a subdomain, not something you can register, so it is rejected
  // rather than quietly reduced to the registrable part.
  if (labelParts.length !== 1) return null;
  if (!LABEL_PATTERN.test(label)) return null;
  if (!tld.split(".").every((part) => LABEL_PATTERN.test(part))) return null;

  return { label, tld, domain: `${label}.${tld}` };
}

/**
 * What to offer for a given search.
 *
 * A query with a dot is taken at face value and checked as typed — that is
 * what the person asked about. A bare word becomes one candidate per suggested
 * TLD. Returns an empty list when the query cannot make a valid domain at all.
 */
export function buildDomainCandidates(
  query: string,
  options: { tlds?: readonly string[]; knownTlds?: Iterable<string> } = {}
): ParsedDomain[] {
  const normalized = normalizeDomainQuery(query);
  if (!normalized) return [];

  if (normalized.includes(".")) {
    const parsed = parseDomain(normalized, options.knownTlds);
    return parsed ? [parsed] : [];
  }

  if (!LABEL_PATTERN.test(normalized)) return [];
  const tlds = options.tlds ?? SUGGESTED_TLDS;
  return tlds.map((tld) => ({ label: normalized, tld, domain: `${normalized}.${tld}` }));
}

/**
 * A decimal price string to integer cents.
 *
 * String-based on purpose: `Math.round(parseFloat("11.08") * 100)` happens to
 * give 1108, but the whole family of these conversions is one float
 * representation away from being a cent out, and this value is what gets sent
 * as the amount to charge. Returns null rather than 0 for anything unparseable,
 * because a price we could not read must stop the flow, not silently become
 * free.
 */
export function toCents(price: string | number | null | undefined): number | null {
  if (price === null || price === undefined) return null;
  const raw = String(price).trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;

  const [whole, fraction = ""] = raw.split(".");
  // Pad or round to exactly two decimal places without going through a float.
  const cents = fraction.length <= 2
    ? Number(fraction.padEnd(2, "0"))
    : Math.round(Number(`0.${fraction}`) * 100);
  const total = Number(whole) * 100 + cents;
  return Number.isSafeInteger(total) ? total : null;
}

/** Integer cents to the string shown to a customer. */
export function formatCents(cents: number | null | undefined, currencySymbol = "$"): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "—";
  const negative = cents < 0;
  const absolute = Math.abs(Math.round(cents));
  const body = `${currencySymbol}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
  return negative ? `-${body}` : body;
}
