/**
 * Reading Namecheap's XML API responses. Pure, so every shape is tested.
 *
 * Namecheap answers with flat XML where nearly everything that matters is an
 * attribute on one tag (`<DomainCreateResult Registered="true" ...>`), so a
 * small attribute reader covers it without a parser dependency. The shapes here
 * were observed against the live API, not taken from memory. Two details:
 *
 * - A multi-year `Price` is the TOTAL for the term, not per year: .com 2 years
 *   is 26.26 = an 11.28 first-year promo + a 14.98 second year. The ICANN fee
 *   (`YourAdditonalCost`, Namecheap's spelling) is per year on top, and is
 *   simply absent on TLDs that have none (.io).
 * - Money is a decimal string ("11.28"). It goes through `toCents`, which is
 *   string-based, because these numbers become the amount charged.
 */

import { toCents } from "./domain-search";

/** Attributes of one tag: `<X A="1" B="two">` -> { A: "1", B: "two" }. */
export function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of tag.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) {
    out[match[1]] = decodeEntities(match[2]);
  }
  return out;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Every opening (or self-closing) tag with this name. */
export function findTags(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}(?=[\\s/>])[^>]*>`, "g"))].map((m) => m[0]);
}

/** Text content of the first `<name>text</name>`. */
export function textOf(xml: string, name: string): string | null {
  const match = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`));
  return match ? decodeEntities(match[1].trim()) : null;
}

export function apiStatus(xml: string): "OK" | "ERROR" | null {
  const tag = findTags(xml, "ApiResponse")[0];
  const status = tag ? attrs(tag).Status : undefined;
  return status === "OK" || status === "ERROR" ? status : null;
}

export type NamecheapApiError = { number: string; message: string };

export function apiErrors(xml: string): NamecheapApiError[] {
  return [...xml.matchAll(/<Error(?:\s[^>]*)?>([^<]*)<\/Error>/g)].map((m) => ({
    number: attrs(m[0]).Number ?? "",
    message: decodeEntities(m[1].trim())
  }));
}

function bool(value: string | undefined): boolean {
  return String(value ?? "").toLowerCase() === "true";
}

/** "01/07/2027" (MM/DD/YYYY, how Namecheap writes dates) -> Date at UTC midnight. */
export function parseNamecheapDate(value: string | null | undefined): Date | null {
  const match = String(value ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const [month, day, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC rolls 13/45 over into a later month; an impossible date is no date.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/** One term's wholesale cost: `priceCents` is the whole term; `additionalCents` is per year. */
export type TermPrice = { years: number; priceCents: number; additionalCents: number };

export type TldPriceBook = {
  tld: string;
  register: TermPrice[];
  renew: TermPrice[];
  transfer: TermPrice[];
};

const CATEGORY_KEYS: Record<string, keyof Omit<TldPriceBook, "tld">> = {
  register: "register",
  renew: "renew",
  transfer: "transfer"
};

/**
 * `users.getPricing` -> price books by TLD. Works for one TLD (ProductName
 * set, every action in one reply) and for a whole action list.
 */
export function parseTldPriceBooks(xml: string): Map<string, TldPriceBook> {
  const books = new Map<string, TldPriceBook>();
  for (const category of xml.matchAll(/<ProductCategory Name="([^"]*)">([\s\S]*?)<\/ProductCategory>/g)) {
    const key = CATEGORY_KEYS[category[1].toLowerCase()];
    if (!key) continue;
    for (const product of category[2].matchAll(/<Product Name="([^"]*)">([\s\S]*?)<\/Product>/g)) {
      const tld = product[1].toLowerCase();
      const book = books.get(tld) ?? { tld, register: [], renew: [], transfer: [] };
      for (const priceTag of findTags(product[2], "Price")) {
        const a = attrs(priceTag);
        if ((a.DurationType ?? "YEAR").toUpperCase() !== "YEAR") continue;
        const years = Number(a.Duration);
        const priceCents = toCents(a.YourPrice ?? a.Price);
        if (!Number.isInteger(years) || years < 1 || priceCents === null) continue;
        const additionalCents = toCents(a.YourAdditonalCost ?? a.YourAdditionalCost ?? a.AdditionalCost) ?? 0;
        book[key].push({ years, priceCents, additionalCents });
      }
      book[key].sort((x, y) => x.years - y.years);
      books.set(tld, book);
    }
  }
  return books;
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export type CheckResult = {
  domain: string;
  available: boolean;
  premium: boolean;
  premiumRegistrationCents: number | null;
  errorNo: string;
  description: string;
};

export function parseCheck(xml: string): CheckResult[] {
  return findTags(xml, "DomainCheckResult").map((tag) => {
    const a = attrs(tag);
    return {
      domain: (a.Domain ?? "").toLowerCase(),
      available: bool(a.Available),
      premium: bool(a.IsPremiumName),
      premiumRegistrationCents: toCents(a.PremiumRegistrationPrice),
      errorNo: a.ErrorNo ?? "0",
      description: a.Description ?? ""
    };
  });
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export type RegistrarOrderResult = {
  domain: string;
  succeeded: boolean;
  chargedCents: number | null;
  domainId: string | null;
  orderId: string | null;
  transactionId: string | null;
  transferId: string | null;
  expiresAt: Date | null;
};

function orderResult(tag: string | undefined, successAttr: string, xml: string): RegistrarOrderResult | null {
  if (!tag) return null;
  const a = attrs(tag);
  return {
    domain: (a.Domain ?? a.DomainName ?? "").toLowerCase(),
    succeeded: bool(a[successAttr]),
    chargedCents: toCents(a.ChargedAmount),
    domainId: a.DomainID || null,
    orderId: a.OrderID || null,
    transactionId: a.TransactionID || null,
    transferId: a.TransferID || null,
    expiresAt: parseNamecheapDate(textOf(xml, "ExpiredDate"))
  };
}

export function parseCreate(xml: string): RegistrarOrderResult | null {
  return orderResult(findTags(xml, "DomainCreateResult")[0], "Registered", xml);
}

export function parseRenew(xml: string): RegistrarOrderResult | null {
  return orderResult(findTags(xml, "DomainRenewResult")[0], "Renew", xml);
}

export function parseTransferCreate(xml: string): RegistrarOrderResult | null {
  return orderResult(findTags(xml, "DomainTransferCreateResult")[0], "Transfer", xml);
}

export type TransferStatus = { transferId: string; status: string; statusId: string };

export function parseTransferStatus(xml: string): TransferStatus | null {
  const tag = findTags(xml, "DomainTransferGetStatusResult")[0];
  if (!tag) return null;
  const a = attrs(tag);
  return { transferId: a.TransferID ?? "", status: a.Status ?? "", statusId: a.StatusID ?? "" };
}

/** Cancelled, failed or rejected: the transfer will not complete on its own. */
export function isTransferDead(status: TransferStatus): boolean {
  return /cancel|fail|reject|timeout|timed out|denied/i.test(status.status);
}

export type DomainInfo = {
  domain: string;
  isOwner: boolean;
  status: string;
  createdAt: Date | null;
  expiresAt: Date | null;
  nameservers: string[];
  usingRegistrarDns: boolean;
  whoisguard: boolean;
};

export function parseGetInfo(xml: string): DomainInfo | null {
  const tag = findTags(xml, "DomainGetInfoResult")[0];
  if (!tag) return null;
  const a = attrs(tag);
  const dns = findTags(xml, "DnsDetails")[0];
  const whoisguard = findTags(xml, "Whoisguard")[0];
  return {
    domain: (a.DomainName ?? "").toLowerCase(),
    isOwner: bool(a.IsOwner),
    status: a.Status ?? "",
    createdAt: parseNamecheapDate(textOf(xml, "CreatedDate")),
    expiresAt: parseNamecheapDate(textOf(xml, "ExpiredDate")),
    nameservers: [...xml.matchAll(/<Nameserver>([^<]+)<\/Nameserver>/g)].map((m) => m[1].trim().toLowerCase()),
    usingRegistrarDns: dns ? bool(attrs(dns).IsUsingOurDNS) : false,
    whoisguard: whoisguard ? bool(attrs(whoisguard).Enabled) : false
  };
}

export function parseSetCustom(xml: string): boolean {
  const tag = findTags(xml, "DomainDNSSetCustomResult")[0];
  return tag ? bool(attrs(tag).Updated ?? attrs(tag).Update) : false;
}

export function parseBalance(xml: string): { availableCents: number | null; currency: string } | null {
  const tag = findTags(xml, "UserGetBalancesResult")[0];
  if (!tag) return null;
  const a = attrs(tag);
  return { availableCents: toCents(a.AvailableBalance), currency: a.Currency ?? "USD" };
}
