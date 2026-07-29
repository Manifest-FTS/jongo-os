/**
 * Rate-limit awareness for the Coolify client.
 *
 * Coolify allows 200 requests per minute per API token (API_RATE_LIMIT, see the
 * upstream RouteServiceProvider). A platform-wide reconcile pass over 43 apps
 * exceeds that on its own, so the later stages of the pass received nothing but
 * 429s — which the capability check then interpreted as "this app has no data",
 * hiding backups from apps that have databases.
 *
 * Two jobs here:
 *
 *   1. Make a 429 identifiable. A rate-limit rejection says nothing about the
 *      resource being asked about, and callers must be able to tell it apart
 *      from a real 404 so they never turn it into a factual conclusion.
 *   2. Stop digging. Once the limit is hit, every further call in that window
 *      is wasted and keeps the limiter pinned. The breaker short-circuits until
 *      the window is likely to have rolled over.
 *
 * The breaker is per-process and intentionally simple: this runs in one Next.js
 * server, and the goal is to stop a burst, not to coordinate a cluster.
 */

export class CoolifyRateLimitError extends Error {
  readonly rateLimited = true;
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`Coolify rate limit reached; retry in ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = "CoolifyRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export function isRateLimitError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { rateLimited?: boolean }).rateLimited === true);
}

/** Default cooldown: Coolify's window is per minute, so wait one out. */
const DEFAULT_COOLDOWN_MS = 60_000;

let openUntil = 0;

/** Milliseconds remaining before calls should be attempted again; 0 if open. */
export function rateLimitCooldownRemaining(now: number = Date.now()): number {
  return openUntil > now ? openUntil - now : 0;
}

export function isRateLimited(now: number = Date.now()): boolean {
  return rateLimitCooldownRemaining(now) > 0;
}

/**
 * Record a 429. `retryAfterSeconds` comes from the Retry-After header when
 * Coolify sends one; otherwise a full window is assumed.
 */
export function noteRateLimited(retryAfterSeconds?: number | null, now: number = Date.now()): number {
  const parsed = Number(retryAfterSeconds);
  const cooldown = Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed * 1000, 5 * 60_000)
    : DEFAULT_COOLDOWN_MS;
  openUntil = Math.max(openUntil, now + cooldown);
  return cooldown;
}

/** Test seam, and a way to clear the breaker after a successful window. */
export function resetRateLimit(): void {
  openUntil = 0;
}

/**
 * A non-2xx response that is NOT a rate limit.
 *
 * The status matters: asking whether a resource is a service or a database is
 * done by fetching it, so a 404 is a legitimate "no, it is not that kind of
 * thing" and must not be mistaken for "we could not find out". Conflating the
 * two made every ordinary application report as undetermined, which meant its
 * capability could never be established or cached.
 */
export class CoolifyHttpError extends Error {
  readonly status: number;

  constructor(status: number, path: string) {
    super(`Coolify request failed (${status}) for ${path}`);
    this.name = "CoolifyHttpError";
    this.status = status;
  }
}

/** True when the failure says the resource is not there, rather than that we could not ask. */
export function isNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { status?: number }).status === 404);
}
