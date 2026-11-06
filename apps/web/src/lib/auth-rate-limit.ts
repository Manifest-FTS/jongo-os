/**
 * Rate limits for sign-in, registration, password reset and invite acceptance.
 *
 * Fixed windows stored in Postgres (RateLimitBucket), updated with one atomic
 * upsert, so limits hold across restarts and replicas — unlike the in-memory
 * gates used elsewhere for non-security throttling.
 *
 * Keys are hashed: the table never holds an email address or IP.
 *
 * Fails OPEN on a database error. Every flow guarded here needs the database
 * anyway, and a limiter outage must not lock every user out; the error is
 * logged so it is visible.
 */
import { createHash } from "node:crypto";

export type RateLimitRule = { scope: string; limit: number; windowSeconds: number };

export const AUTH_RATE_LIMITS = {
  loginPerEmail: { scope: "login:email", limit: 10, windowSeconds: 15 * 60 },
  loginPerIp: { scope: "login:ip", limit: 30, windowSeconds: 15 * 60 },
  registerPerIp: { scope: "register:ip", limit: 5, windowSeconds: 60 * 60 },
  forgotPerIp: { scope: "forgot:ip", limit: 10, windowSeconds: 15 * 60 },
  forgotPerEmail: { scope: "forgot:email", limit: 3, windowSeconds: 60 * 60 },
  resetPerIp: { scope: "reset:ip", limit: 10, windowSeconds: 15 * 60 },
  inviteAcceptPerIp: { scope: "invite:ip", limit: 10, windowSeconds: 15 * 60 },
  // Not sign-in, but the same shape: each new client creates a hosting project.
  createClientPerUser: { scope: "client-create:user", limit: 20, windowSeconds: 60 * 60 },
  // Framework detection reads the repo from the Git host on each call.
  repoInspectPerUser: { scope: "repo-inspect:user", limit: 60, windowSeconds: 10 * 60 },
  // Each deploy key is stored in hosting.
  deployKeyPerOrg: { scope: "deploy-key:org", limit: 10, windowSeconds: 60 * 60 }
} satisfies Record<string, RateLimitRule>;

export type RateLimitResult = { allowed: boolean; retryAfterSeconds: number };

type Db = { $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown> };

export function rateLimitKey(scope: string, identifier: string): string {
  return createHash("sha256").update(`${scope}\u0000${identifier.trim().toLowerCase()}`).digest("hex");
}

/**
 * The client address as Traefik reports it. X-Real-IP is set by the proxy from
 * the connection; X-Forwarded-For's first entry is the fallback. Either can be
 * forged if the app is reached without the proxy, which is why per-account
 * limits are applied alongside per-IP ones.
 */
export function clientIp(headers: Headers | Record<string, unknown> | undefined | null): string {
  const read = (name: string): string => {
    if (!headers) return "";
    if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? "";
    const value = (headers as Record<string, unknown>)[name];
    return Array.isArray(value) ? String(value[0] ?? "") : typeof value === "string" ? value : "";
  };
  return read("x-real-ip").trim() || read("x-forwarded-for").split(",")[0]?.trim() || "unknown";
}

async function loadDb(): Promise<Db> {
  const { db } = await import("@/lib/db");
  return db as Db;
}

/** Count one attempt against `rule` for `identifier`. */
export async function hitRateLimit(
  rule: RateLimitRule,
  identifier: string,
  options: { db?: Db; now?: Date } = {}
): Promise<RateLimitResult> {
  if (!identifier.trim()) return { allowed: true, retryAfterSeconds: 0 };
  const key = rateLimitKey(rule.scope, identifier);
  try {
    const db = options.db ?? (await loadDb());
    // Timestamps are naive UTC (Prisma's convention), so every "now" here is
    // `now() at time zone 'utc'` to stay correct whatever the session timezone.
    const rows = (await db.$queryRaw`
      insert into "RateLimitBucket" ("key", "count", "windowStart")
      values (${key}, 1, now() at time zone 'utc')
      on conflict ("key") do update set
        "count" = case
          when "RateLimitBucket"."windowStart" <= (now() at time zone 'utc') - (${rule.windowSeconds}::int * interval '1 second') then 1
          else "RateLimitBucket"."count" + 1
        end,
        "windowStart" = case
          when "RateLimitBucket"."windowStart" <= (now() at time zone 'utc') - (${rule.windowSeconds}::int * interval '1 second') then now() at time zone 'utc'
          else "RateLimitBucket"."windowStart"
        end
      returning "count", "windowStart"
    `) as Array<{ count: number; windowStart: Date }>;

    const row = rows[0];
    if (!row) return { allowed: true, retryAfterSeconds: 0 };

    // Occasional cleanup so the table only holds live windows.
    if (Math.random() < 0.01) {
      db.$queryRaw`delete from "RateLimitBucket" where "windowStart" < (now() at time zone 'utc') - interval '1 day'`.catch(() => undefined);
    }

    const allowed = Number(row.count) <= rule.limit;
    const now = (options.now ?? new Date()).getTime();
    const resetAt = new Date(row.windowStart).getTime() + rule.windowSeconds * 1000;
    return { allowed, retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((resetAt - now) / 1000)) };
  } catch (error) {
    console.error(`[rate-limit] ${rule.scope} check failed; allowing the request.`, error);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

/** Apply several rules; blocked if any one is exceeded. Every rule is counted. */
export async function hitRateLimits(
  checks: Array<[RateLimitRule, string]>,
  options: { db?: Db; now?: Date } = {}
): Promise<RateLimitResult> {
  const results = await Promise.all(checks.map(([rule, identifier]) => hitRateLimit(rule, identifier, options)));
  const blocked = results.filter((result) => !result.allowed);
  return blocked.length === 0
    ? { allowed: true, retryAfterSeconds: 0 }
    : { allowed: false, retryAfterSeconds: Math.max(...blocked.map((result) => result.retryAfterSeconds)) };
}

export function tooManyAttemptsMessage(retryAfterSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}
