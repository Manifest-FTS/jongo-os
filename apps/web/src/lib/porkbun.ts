/**
 * The Porkbun client: domain availability, pricing, registration and
 * transfer-in.
 *
 * Every request and response shape in here was observed against the sandbox
 * (`pk1_sb_…` keys, `"sandbox": true` on every reply) rather than taken from
 * memory, because two details are not what you would guess and both matter:
 *
 * 1. **Units disagree between endpoints.** `checkDomain` and `pricing/get`
 *    return decimal strings ("11.08"); `domain/create` and `domain/transfer`
 *    take integer cents (1108). Conversion goes through `toCents` in
 *    lib/domain-search.ts, which is string-based and tested, because this
 *    number is the amount charged.
 *
 * 2. **`checkDomain` allows one call every ten seconds, per key.** Not per
 *    visitor — per Jongo. See lib/rate-gate.ts for what that forces. The
 *    practical consequence for anyone reading this later: DO NOT add an
 *    as-you-type availability check, and do not check a fan of six TLDs on one
 *    submit. `pricing/get` is unauthenticated and unthrottled, so prices are
 *    free to show; availability is the scarce thing.
 *
 * ## The third state
 *
 * `checkAvailability` returns `available`, `taken`, or `unknown` — never a
 * boolean. When the rate limit, a network failure or a missing config stops us
 * finding out, the answer is `unknown` with a reason, and the UI says so.
 * Rendering "available" for a domain we could not check would send someone to
 * a checkout that then fails at the registry, which is the same class of bug as
 * a flush button that reports success without flushing.
 */

import { formatCents, toCents } from "@/lib/domain-search";
import { MinIntervalGate, SingleFlightCache } from "@/lib/rate-gate";

const API_BASE = "https://api.porkbun.com/api/json/v3";

/**
 * The documented ceiling is one check per ten seconds. We aim slightly under
 * it so that clock skew between us and them does not turn every call into a
 * 429, and `penalize()` defers to the server's own `ttlRemaining` whenever we
 * do trip it.
 */
const CHECK_INTERVAL_MS = 10_500;

/**
 * How long a visitor's request will sit waiting for a gate slot. Past this we
 * answer `unknown` with a retry hint instead: a person will wait a couple of
 * seconds for a domain lookup and will not wait thirty.
 */
const CHECK_MAX_WAIT_MS = 2500;

/** Availability changes rarely; a repeat search inside this window is free. */
const CHECK_CACHE_TTL_MS = 5 * 60_000;

/** The TLD price list is effectively static. Re-reading it hourly is plenty. */
const PRICING_CACHE_TTL_MS = 60 * 60_000;

const REQUEST_TIMEOUT_MS = 15_000;

export type PorkbunConfig = {
  apiKey: string;
  secretApiKey: string;
  /**
   * True when the credentials are sandbox ones. Derived from the key rather
   * than a separate flag so the two can never disagree — a separate
   * PORKBUN_SANDBOX=true alongside a live key is exactly the mistake that
   * spends real money.
   */
  sandbox: boolean;
};

export function readPorkbunConfig(): PorkbunConfig | null {
  const apiKey = (process.env.PORKBUN_API_KEY || "").trim();
  const secretApiKey = (process.env.PORKBUN_SECRET_API_KEY || "").trim();
  if (!apiKey || !secretApiKey) return null;
  return { apiKey, secretApiKey, sandbox: isSandboxKey(apiKey) };
}

/** Sandbox keys are prefixed `pk1_sb_` / `sk1_sb_`. */
export function isSandboxKey(key: string): boolean {
  return /^(pk|sk)1_sb_/.test(key.trim());
}

export function isPorkbunConfigured(): boolean {
  return readPorkbunConfig() !== null;
}

type PorkbunEnvelope = Record<string, unknown> & {
  status?: string;
  message?: string;
  code?: string;
  ttlRemaining?: number;
  sandbox?: boolean;
};

class PorkbunError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly retryAfterMs: number | null,
    readonly httpStatus: number | null
  ) {
    super(message);
    this.name = "PorkbunError";
  }
}

/**
 * One POST to the API.
 *
 * Credentials go in the body, which is where the docs put them and — unlike
 * the header alternative — keeps them out of anything that logs request
 * metadata. `auth: false` is for `pricing/get`, which takes no credentials at
 * all, so the public price list never carries a key.
 */
async function porkbunFetch(
  path: string,
  body: Record<string, unknown> = {},
  options: { auth?: boolean; config?: PorkbunConfig | null; cache?: RequestCache } = {}
): Promise<PorkbunEnvelope> {
  const wantsAuth = options.auth !== false;
  const config = options.config ?? (wantsAuth ? readPorkbunConfig() : null);
  if (wantsAuth && !config) {
    throw new PorkbunError("Porkbun API credentials are not configured.", "NOT_CONFIGURED", null, null);
  }

  const payload = config
    ? { apikey: config.apiKey, secretapikey: config.secretApiKey, ...body }
    : body;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      // `no-store` by default: an availability answer or an order must never
      // be served from a cache. It is overridable because specifying it AT ALL
      // opts the calling route out of static generation in the App Router, and
      // the public price list is read from a page we want prerendered — that
      // one passes "default" and relies on this module's own hour-long cache
      // instead.
      cache: options.cache ?? "no-store"
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    throw new PorkbunError(
      aborted ? "The domain registry timed out." : "Could not reach the domain registry.",
      aborted ? "TIMEOUT" : "NETWORK",
      null,
      null
    );
  } finally {
    clearTimeout(timeout);
  }

  const envelope = (await response.json().catch(() => ({}))) as PorkbunEnvelope;

  if (envelope.status === "ERROR" || !response.ok) {
    // `ttlRemaining` is seconds and is the server telling us when it will
    // answer again; the Retry-After header carries the same thing.
    const headerRetry = Number(response.headers.get("retry-after"));
    const ttl = typeof envelope.ttlRemaining === "number" ? envelope.ttlRemaining : null;
    const retrySeconds = ttl ?? (Number.isFinite(headerRetry) ? headerRetry : null);
    throw new PorkbunError(
      typeof envelope.message === "string" && envelope.message
        ? envelope.message
        : `The domain registry rejected the request (HTTP ${response.status}).`,
      typeof envelope.code === "string" ? envelope.code : null,
      retrySeconds !== null ? retrySeconds * 1000 : null,
      response.status
    );
  }

  return envelope;
}

/** Confirms the credentials work. Used by the diagnostics surface, not by page loads. */
export async function pingPorkbun(): Promise<
  { ok: true; sandbox: boolean; ip: string } | { ok: false; message: string }
> {
  try {
    const envelope = await porkbunFetch("/ping");
    return {
      ok: true,
      sandbox: envelope.sandbox === true,
      ip: typeof envelope.yourIp === "string" ? envelope.yourIp : ""
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Ping failed." };
  }
}

// ---------------------------------------------------------------------------
// TLD pricing
// ---------------------------------------------------------------------------

export type TldPrice = {
  tld: string;
  registrationCents: number | null;
  renewalCents: number | null;
  transferCents: number | null;
};

const pricingCache = new SingleFlightCache<Map<string, TldPrice>>(PRICING_CACHE_TTL_MS);

/**
 * The whole TLD price list.
 *
 * Unauthenticated and not rate limited, which is what makes the homepage
 * possible: it can show ".com from $11.08" for a handful of TLDs without
 * spending any of the availability budget.
 */
export async function getTldPricing(): Promise<Map<string, TldPrice>> {
  const { value } = await pricingCache.get("all", async () => {
    const envelope = await porkbunFetch("/pricing/get", {}, { auth: false, cache: "default" });
    const raw = envelope.pricing;
    const prices = new Map<string, TldPrice>();
    if (raw && typeof raw === "object") {
      for (const [tld, entry] of Object.entries(raw as Record<string, unknown>)) {
        if (!entry || typeof entry !== "object") continue;
        const record = entry as Record<string, unknown>;
        prices.set(tld.toLowerCase(), {
          tld: tld.toLowerCase(),
          registrationCents: toCents(record.registration as string),
          renewalCents: toCents(record.renewal as string),
          transferCents: toCents(record.transfer as string)
        });
      }
    }
    return prices;
  });
  return value;
}

/** Prices for a specific set of TLDs, in the order asked for. */
export async function getPricesForTlds(tlds: readonly string[]): Promise<TldPrice[]> {
  const pricing = await getTldPricing();
  return tlds.map(
    (tld) =>
      pricing.get(tld.toLowerCase()) ?? {
        tld: tld.toLowerCase(),
        registrationCents: null,
        renewalCents: null,
        transferCents: null
      }
  );
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export type AvailabilityUnknownReason =
  | "rate_limited"
  | "not_configured"
  | "upstream_error"
  | "invalid_domain";

export type DomainAvailability =
  | {
      state: "available";
      domain: string;
      priceCents: number | null;
      priceDisplay: string;
      renewalCents: number | null;
      transferCents: number | null;
      premium: boolean;
      /** True when `price` is a first-year promo and `regularPrice` is higher. */
      firstYearPromo: boolean;
      regularPriceCents: number | null;
      minDuration: number;
      sandbox: boolean;
    }
  | {
      state: "taken";
      domain: string;
      /** What moving it here would cost, which is the useful next step. */
      transferCents: number | null;
      transferDisplay: string;
      sandbox: boolean;
    }
  | {
      state: "unknown";
      domain: string;
      reason: AvailabilityUnknownReason;
      message: string;
      /** Present for `rate_limited`, so the UI can say when to try again. */
      retryAfterMs: number | null;
    };

const checkGate = new MinIntervalGate(CHECK_INTERVAL_MS, CHECK_MAX_WAIT_MS);
const checkCache = new SingleFlightCache<DomainAvailability>(CHECK_CACHE_TTL_MS);

/**
 * Is this domain registrable, and for how much?
 *
 * The order here is what keeps the rate limit workable: cache first (free),
 * then coalesce concurrent identical searches into one upstream call, and only
 * then take a gate slot. A search for a domain someone already looked up in
 * the last five minutes costs nothing at all.
 */
export async function checkAvailability(domain: string): Promise<DomainAvailability> {
  const target = domain.trim().toLowerCase();
  if (!target || !target.includes(".")) {
    return {
      state: "unknown",
      domain: target,
      reason: "invalid_domain",
      message: "That does not look like a domain name.",
      retryAfterMs: null
    };
  }

  if (!isPorkbunConfigured()) {
    return {
      state: "unknown",
      domain: target,
      reason: "not_configured",
      message: "Domain search is not connected yet.",
      retryAfterMs: null
    };
  }

  const cached = checkCache.peek(target);
  if (cached) return cached;

  const { value } = await checkCache.get(target, async () => {
    const admission = await checkGate.acquire();
    if (!admission.admitted) {
      // Deliberately NOT cached: this says nothing about the domain, only
      // about how busy we are, and caching it would keep answering "busy"
      // after the queue cleared.
      return {
        state: "unknown" as const,
        domain: target,
        reason: "rate_limited" as const,
        message: "Too many domain searches at once. Try that again in a moment.",
        retryAfterMs: admission.retryAfterMs
      };
    }

    try {
      const envelope = await porkbunFetch(`/domain/checkDomain/${encodeURIComponent(target)}`);
      const response = (envelope.response ?? {}) as Record<string, unknown>;
      const sandbox = envelope.sandbox === true;

      const additional = (response.additional ?? {}) as Record<string, unknown>;
      const renewal = (additional.renewal ?? {}) as Record<string, unknown>;
      const transfer = (additional.transfer ?? {}) as Record<string, unknown>;
      const transferCents = toCents(transfer.price as string);

      // "yes" / "no" strings, not booleans. Anything else is not an answer.
      if (response.avail !== "yes" && response.avail !== "no") {
        return {
          state: "unknown" as const,
          domain: target,
          reason: "upstream_error" as const,
          message: "The registry did not say whether that domain is available.",
          retryAfterMs: null
        };
      }

      if (response.avail === "no") {
        return {
          state: "taken" as const,
          domain: target,
          transferCents,
          transferDisplay: formatCents(transferCents),
          sandbox
        };
      }

      const priceCents = toCents(response.price as string);
      const regularPriceCents = toCents(response.regularPrice as string);
      return {
        state: "available" as const,
        domain: target,
        priceCents,
        priceDisplay: formatCents(priceCents),
        renewalCents: toCents(renewal.price as string),
        transferCents,
        premium: response.premium === "yes",
        firstYearPromo: response.firstYearPromo === "yes",
        regularPriceCents,
        minDuration: typeof response.minDuration === "number" ? response.minDuration : 1,
        sandbox
      };
    } catch (error) {
      if (error instanceof PorkbunError && error.code === "RATE_LIMIT_EXCEEDED") {
        // We got through our own gate but they still said no, so believe them
        // over our arithmetic for the next caller.
        if (error.retryAfterMs) checkGate.penalize(error.retryAfterMs);
        return {
          state: "unknown" as const,
          domain: target,
          reason: "rate_limited" as const,
          message: "Too many domain searches at once. Try that again in a moment.",
          retryAfterMs: error.retryAfterMs
        };
      }
      return {
        state: "unknown" as const,
        domain: target,
        reason: "upstream_error" as const,
        message:
          error instanceof Error && error.message
            ? error.message
            : "The domain registry could not be reached.",
        retryAfterMs: null
      };
    }
  });

  // An `unknown` is never worth remembering — it describes us, not the domain.
  if (value.state === "unknown") checkCache.invalidate(target);
  return value;
}

// ---------------------------------------------------------------------------
// Registration and transfer
// ---------------------------------------------------------------------------

export type OrderOutcome =
  | {
      ok: true;
      domain: string;
      /** Absent on a dry run — nothing was ordered. */
      orderId: number | null;
      transferId: number | null;
      costCents: number | null;
      costDisplay: string;
      balanceCents: number | null;
      dryRun: boolean;
      sandbox: boolean;
      message: string;
    }
  | {
      ok: false;
      domain: string;
      code: string | null;
      message: string;
      dryRun: boolean;
      /** Set when the failure was purely "not enough credit". */
      insufficientFunds: boolean;
    };

/**
 * Register a domain.
 *
 * `costCents` is required rather than looked up here on purpose: the live API
 * checks it against the registry's own price and rejects a mismatch, which is
 * the guard against a price moving between the quote someone saw and the order
 * they placed. Passing whatever the API currently says would defeat that, so
 * the caller must pass the figure it QUOTED and accept a rejection if it has
 * since changed.
 *
 * `dryRun` returns exactly the same decision the real call would make, with no
 * order and no charge — so the checkout can validate before it commits.
 */
export async function registerDomain(input: {
  domain: string;
  costCents: number;
  years?: number;
  whoisPrivacy?: boolean;
  dryRun?: boolean;
}): Promise<OrderOutcome> {
  return placeOrder("registration", `/domain/create/${encodeURIComponent(input.domain.trim().toLowerCase())}`, {
    domain: input.domain.trim().toLowerCase(),
    dryRun: input.dryRun ?? false,
    body: {
      cost: input.costCents,
      agreeToTerms: "yes",
      whoisPrivacy: input.whoisPrivacy ?? true,
      ...(input.years && input.years > 1 ? { years: input.years } : {}),
      dryRun: input.dryRun ?? false
    }
  });
}

/**
 * Transfer a domain in.
 *
 * Needs the auth/EPP code from the losing registrar. Note that in the SANDBOX a
 * dry run reports `wouldSucceed: true` even for a domain that is not registered
 * anywhere and an auth code that is nonsense — the test environment does not
 * reach a registry. So a green dry run here is evidence the request is
 * well-formed, NOT evidence the transfer will work. Do not present it to a
 * customer as confirmation.
 */
export async function transferDomain(input: {
  domain: string;
  authCode: string;
  costCents: number;
  dryRun?: boolean;
}): Promise<OrderOutcome> {
  const domain = input.domain.trim().toLowerCase();
  if (!input.authCode.trim()) {
    return {
      ok: false,
      domain,
      code: "MISSING_AUTH_CODE",
      message: "A transfer needs the authorization code from your current registrar.",
      dryRun: input.dryRun ?? false,
      insufficientFunds: false
    };
  }

  return placeOrder("transfer", `/domain/transfer/${encodeURIComponent(domain)}`, {
    domain,
    dryRun: input.dryRun ?? false,
    body: {
      authCode: input.authCode.trim(),
      cost: input.costCents,
      dryRun: input.dryRun ?? false
    }
  });
}

async function placeOrder(
  operation: "registration" | "transfer",
  path: string,
  params: { domain: string; dryRun: boolean; body: Record<string, unknown> }
): Promise<OrderOutcome> {
  if (!isPorkbunConfigured()) {
    return {
      ok: false,
      domain: params.domain,
      code: "NOT_CONFIGURED",
      message: "Domain ordering is not connected yet.",
      dryRun: params.dryRun,
      insufficientFunds: false
    };
  }

  try {
    const envelope = await porkbunFetch(path, params.body);

    // A dry run reports its verdict in `wouldSucceed` while still returning
    // status SUCCESS, so "the call worked" and "the order would work" are two
    // different questions and both have to be asked.
    if (envelope.dryRun === true && envelope.wouldSucceed !== true) {
      const sufficient = envelope.sufficientFunds;
      return {
        ok: false,
        domain: params.domain,
        code: "WOULD_FAIL",
        message:
          typeof envelope.message === "string" && envelope.message
            ? envelope.message
            : `That ${operation} would not go through.`,
        dryRun: true,
        insufficientFunds: sufficient === false
      };
    }

    const costCents = typeof envelope.cost === "number" ? envelope.cost : null;
    return {
      ok: true,
      domain: params.domain,
      orderId: typeof envelope.orderId === "number" ? envelope.orderId : null,
      transferId: typeof envelope.transferId === "number" ? envelope.transferId : null,
      costCents,
      costDisplay:
        typeof envelope.costDisplay === "string" ? envelope.costDisplay : formatCents(costCents),
      balanceCents: typeof envelope.balance === "number" ? envelope.balance : null,
      dryRun: envelope.dryRun === true,
      sandbox: envelope.sandbox === true,
      message:
        typeof envelope.message === "string" && envelope.message
          ? envelope.message
          : operation === "registration"
            ? "Domain registered."
            : "Transfer started."
    };
  } catch (error) {
    const porkbunError = error instanceof PorkbunError ? error : null;
    return {
      ok: false,
      domain: params.domain,
      code: porkbunError?.code ?? null,
      message:
        error instanceof Error && error.message
          ? error.message
          : `The ${operation} could not be completed.`,
      dryRun: params.dryRun,
      insufficientFunds: porkbunError?.code === "INSUFFICIENT_FUNDS"
    };
  }
}
