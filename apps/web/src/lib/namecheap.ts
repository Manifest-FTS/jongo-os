/**
 * The Namecheap client: availability, wholesale pricing, registration,
 * renewal, transfer-in, and pointing a domain at Cloudflare's nameservers.
 *
 * ## Calls must come from the whitelisted IP
 *
 * Namecheap only answers API calls from the IP in NAMECHEAP_CLIENT_IP, and
 * that must be one whitelisted in the Namecheap account (the Jongo server,
 * 5.78.216.68). From anywhere else every call fails with an auth error, so
 * this cannot be exercised from a laptop: test it on the server.
 *
 * ## Money
 *
 * Orders draw on the Namecheap ACCOUNT BALANCE, not a card. A registration with
 * too little balance fails, after the client has paid us; lib/domain-orders.ts
 * refunds the client when that happens. Reads (check, getPricing, getInfo,
 * getBalances) are free.
 *
 * ## Rate limits
 *
 * Namecheap allows 50 calls a minute (700 an hour) per account. Prices are cached
 * per TLD for hours (one call returns every price for a TLD), availability for
 * five minutes, and every call goes through one gate.
 */

import { MinIntervalGate, SingleFlightCache } from "@/lib/rate-gate";
import type { ParsedDomain } from "@/lib/domain-search";
import { toNamecheapContactParams, type RegistrantContact } from "@/lib/domain-contact";
import {
  apiErrors,
  apiStatus,
  parseBalance,
  parseCheck,
  parseCreate,
  parseGetInfo,
  parseRenew,
  parseSetCustom,
  parseTldPriceBooks,
  parseTransferCreate,
  parseTransferStatus,
  type CheckResult,
  type DomainInfo,
  type RegistrarOrderResult,
  type TldPriceBook,
  type TransferStatus
} from "@/lib/namecheap-xml";

const LIVE_URL = "https://api.namecheap.com/xml.response";
const SANDBOX_URL = "https://api.sandbox.namecheap.com/xml.response";
const REQUEST_TIMEOUT_MS = 30_000;

export type NamecheapConfig = {
  apiUser: string;
  apiKey: string;
  username: string;
  clientIp: string;
  sandbox: boolean;
};

export function readNamecheapConfig(): NamecheapConfig | null {
  const apiKey = (process.env.NAMECHEAP_API_KEY || "").trim();
  const apiUser = (process.env.NAMECHEAP_API_USER || "").trim();
  const username = (process.env.NAMECHEAP_USERNAME || apiUser).trim();
  const clientIp = (process.env.NAMECHEAP_CLIENT_IP || "").trim();
  if (!apiKey || !apiUser || !clientIp) return null;
  // Sandbox only when explicitly "true": the sandbox needs its own account and
  // key, so a live key pointed at it fails every call (observed).
  const sandbox = (process.env.NAMECHEAP_SANDBOX || "").trim().toLowerCase() === "true";
  return { apiUser, apiKey, username, clientIp, sandbox };
}

export function isNamecheapConfigured(): boolean {
  return readNamecheapConfig() !== null;
}

export class NamecheapError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    /** True for failures that say nothing about the request: network, timeout, rate limit. */
    readonly transient: boolean
  ) {
    super(message);
    this.name = "NamecheapError";
  }
}

/** Namecheap error numbers that mean "not enough account balance". */
const INSUFFICIENT_FUNDS = new Set(["2528166", "2033409"]);

export function isInsufficientFunds(error: unknown): boolean {
  return (
    error instanceof NamecheapError &&
    (INSUFFICIENT_FUNDS.has(error.code ?? "") || /insufficient|not enough (funds|balance)/i.test(error.message))
  );
}

// 50 calls/min allowed; one every 1.5 s (40/min) keeps clear of it.
const gate = new MinIntervalGate(1_500, 2_500);

async function takeSlot(patient: boolean): Promise<boolean> {
  // Searches give up quickly; orders wait their turn, because an order that
  // is skipped after payment is far worse than one that is a few seconds late.
  const deadline = Date.now() + (patient ? 60_000 : 0);
  for (;;) {
    const admission = await gate.acquire();
    if (admission.admitted) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(admission.retryAfterMs ?? 1000, 3_000)));
  }
}

/**
 * One API call. POST, with credentials in the body, so neither the key nor an
 * EPP code ends up in a URL that something might log.
 */
async function call(command: string, params: Record<string, string> = {}, options: { patient?: boolean } = {}): Promise<string> {
  const config = readNamecheapConfig();
  if (!config) throw new NamecheapError("Namecheap is not configured.", "NOT_CONFIGURED", false);

  if (!(await takeSlot(Boolean(options.patient)))) {
    throw new NamecheapError("Domain search is busy. Try again in a moment.", "RATE_LIMITED", true);
  }

  const body = new URLSearchParams({
    ApiUser: config.apiUser,
    ApiKey: config.apiKey,
    UserName: config.username,
    ClientIp: config.clientIp,
    Command: command,
    ...params
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let xml: string;
  try {
    const response = await fetch(config.sandbox ? SANDBOX_URL : LIVE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: controller.signal,
      cache: "no-store"
    });
    xml = await response.text();
    if (!response.ok && !xml.includes("<ApiResponse")) {
      throw new NamecheapError(`Namecheap answered HTTP ${response.status}.`, String(response.status), response.status >= 500 || response.status === 429);
    }
  } catch (error) {
    if (error instanceof NamecheapError) throw error;
    const aborted = error instanceof Error && error.name === "AbortError";
    throw new NamecheapError(aborted ? "Namecheap timed out." : "Could not reach Namecheap.", aborted ? "TIMEOUT" : "NETWORK", true);
  } finally {
    clearTimeout(timeout);
  }

  if (apiStatus(xml) !== "OK") {
    const first = apiErrors(xml)[0];
    throw new NamecheapError(first?.message || "Namecheap rejected the request.", first?.number || null, false);
  }
  return xml;
}

export function namecheapMode(): "live" | "sandbox" | "off" {
  const config = readNamecheapConfig();
  return config ? (config.sandbox ? "sandbox" : "live") : "off";
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

const bookCache = new SingleFlightCache<TldPriceBook | null>(6 * 60 * 60_000);
const transferListCache = new SingleFlightCache<Map<string, TldPriceBook>>(12 * 60 * 60_000);

/** Every wholesale price for one TLD (register, renew, transfer). One fast call. */
export async function getPriceBook(tld: string): Promise<TldPriceBook | null> {
  const key = tld.trim().toLowerCase();
  if (!key) return null;
  const { value } = await bookCache.get(key, async () => {
    // Patient: prices are cached for hours, so waiting a turn is cheap, and
    // dropping the lookup showed a TLD with no price at all.
    const xml = await call("namecheap.users.getPricing", { ProductType: "DOMAIN", ProductName: key }, { patient: true });
    return parseTldPriceBooks(xml).get(key) ?? null;
  });
  return value;
}

/**
 * Transfer prices for every TLD Namecheap supports. Also the "known TLDs" list
 * that tells a two-part ending (co.uk) from a subdomain. ~200 KB, under a
 * second; the register and renew lists are 2-3 MB and 20 s, so those are read
 * per TLD instead.
 */
export async function getTransferPriceList(): Promise<Map<string, TldPriceBook>> {
  const { value } = await transferListCache.get("all", async () => {
    const xml = await call("namecheap.users.getPricing", { ProductType: "DOMAIN", ActionName: "TRANSFER" }, { patient: true });
    return parseTldPriceBooks(xml);
  });
  return value;
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

const checkCache = new SingleFlightCache<CheckResult | null>(5 * 60_000);

export async function checkDomain(domain: string, options: { fresh?: boolean; patient?: boolean } = {}): Promise<CheckResult | null> {
  const key = domain.trim().toLowerCase();
  if (options.fresh) checkCache.invalidate(key);
  const { value } = await checkCache.get(key, async () => {
    const xml = await call("namecheap.domains.check", { DomainList: key }, { patient: options.patient });
    return parseCheck(xml).find((result) => result.domain === key) ?? null;
  });
  return value;
}

// ---------------------------------------------------------------------------
// Orders: these spend the account balance
// ---------------------------------------------------------------------------

function requireResult(result: RegistrarOrderResult | null, what: string): RegistrarOrderResult {
  if (!result) throw new NamecheapError(`Namecheap did not confirm the ${what}.`, "NO_RESULT", false);
  if (!result.succeeded) throw new NamecheapError(`Namecheap did not complete the ${what}.`, "NOT_COMPLETED", false);
  return result;
}

export async function registerDomain(input: {
  domain: ParsedDomain;
  years: number;
  contact: RegistrantContact;
  nameservers?: string[];
}): Promise<RegistrarOrderResult> {
  const xml = await call(
    "namecheap.domains.create",
    {
      DomainName: input.domain.domain,
      Years: String(input.years),
      ...toNamecheapContactParams(input.contact),
      AddFreeWhoisguard: "yes",
      WGEnabled: "yes",
      ...(input.nameservers?.length ? { Nameservers: input.nameservers.join(",") } : {})
    },
    { patient: true }
  );
  return requireResult(parseCreate(xml), "registration");
}

export async function renewDomain(input: { domain: ParsedDomain; years: number }): Promise<RegistrarOrderResult> {
  const xml = await call("namecheap.domains.renew", { DomainName: input.domain.domain, Years: String(input.years) }, { patient: true });
  return requireResult(parseRenew(xml), "renewal");
}

/** EPP codes with anything but letters and digits go base64-encoded, as Namecheap asks. */
export function encodeEppCode(code: string): string {
  const trimmed = code.trim();
  return /^[A-Za-z0-9]+$/.test(trimmed) ? trimmed : `base64:${Buffer.from(trimmed, "utf8").toString("base64")}`;
}

export async function transferDomain(input: { domain: ParsedDomain; eppCode: string }): Promise<RegistrarOrderResult> {
  const xml = await call(
    "namecheap.domains.transfer.create",
    {
      DomainName: input.domain.domain,
      Years: "1",
      EPPCode: encodeEppCode(input.eppCode),
      AddFreeWhoisguard: "yes",
      WGenable: "yes"
    },
    { patient: true }
  );
  return requireResult(parseTransferCreate(xml), "transfer");
}

// ---------------------------------------------------------------------------
// Domain state and DNS delegation
// ---------------------------------------------------------------------------

export async function getTransferStatus(transferId: string): Promise<TransferStatus | null> {
  return parseTransferStatus(await call("namecheap.domains.transfer.getStatus", { TransferID: transferId }, { patient: true }));
}

/** Null when the domain is not in this Namecheap account (yet). */
export async function getDomainInfo(domain: string): Promise<DomainInfo | null> {
  try {
    return parseGetInfo(await call("namecheap.domains.getInfo", { DomainName: domain }, { patient: true }));
  } catch (error) {
    if (error instanceof NamecheapError && !error.transient) return null;
    throw error;
  }
}

export async function setCustomNameservers(domain: ParsedDomain, nameservers: string[]): Promise<boolean> {
  const xml = await call(
    "namecheap.domains.dns.setCustom",
    { SLD: domain.label, TLD: domain.tld, Nameservers: nameservers.join(",") },
    { patient: true }
  );
  return parseSetCustom(xml);
}

export async function getBalance(): Promise<{ availableCents: number | null; currency: string } | null> {
  return parseBalance(await call("namecheap.users.getBalances", {}, { patient: true }));
}
