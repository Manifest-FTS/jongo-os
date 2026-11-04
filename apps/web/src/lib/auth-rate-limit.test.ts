import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { clientIp, hitRateLimit, hitRateLimits, rateLimitKey, tooManyAttemptsMessage } from "./auth-rate-limit";

describe("auth rate limit helpers", () => {
  it("hashes keys so no email or IP is stored", () => {
    const key = rateLimitKey("login:email", "Person@Example.com");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain("example");
    expect(rateLimitKey("login:email", "person@example.com ")).toBe(key);
    expect(rateLimitKey("login:ip", "person@example.com")).not.toBe(key);
  });

  it("prefers the proxy's X-Real-IP, then the first forwarded address", () => {
    expect(clientIp(new Headers({ "x-real-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" }))).toBe("1.1.1.1");
    expect(clientIp(new Headers({ "x-forwarded-for": "2.2.2.2, 3.3.3.3" }))).toBe("2.2.2.2");
    expect(clientIp({ "x-forwarded-for": "4.4.4.4" })).toBe("4.4.4.4");
    expect(clientIp(undefined)).toBe("unknown");
  });

  it("fails open, and logs, when the database errors", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = { $queryRaw: vi.fn().mockRejectedValue(new Error("down")) };
    await expect(hitRateLimit({ scope: "t", limit: 1, windowSeconds: 60 }, "x", { db })).resolves.toEqual({
      allowed: true,
      retryAfterSeconds: 0
    });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("blocks once the count passes the limit and reports when to retry", async () => {
    const windowStart = new Date("2026-01-01T00:00:00Z");
    const db = { $queryRaw: vi.fn().mockResolvedValue([{ count: 4, windowStart }]) };
    const result = await hitRateLimit({ scope: "t", limit: 3, windowSeconds: 600 }, "x", {
      db,
      now: new Date("2026-01-01T00:01:00Z")
    });
    expect(result).toEqual({ allowed: false, retryAfterSeconds: 540 });
    expect(tooManyAttemptsMessage(result.retryAfterSeconds)).toBe("Too many attempts. Try again in 9 minutes.");
  });
});

// Runs against a real Postgres when RATE_LIMIT_TEST_DATABASE_URL points at a
// disposable database with the RateLimitBucket migration applied.
const url = process.env.RATE_LIMIT_TEST_DATABASE_URL;
describe.skipIf(!url)("auth rate limit against Postgres", () => {
  let db: any;
  beforeAll(async () => {
    const { PrismaClient } = await import("@prisma/client");
    db = new PrismaClient({ datasources: { db: { url } } });
    await db.$executeRawUnsafe('delete from "RateLimitBucket"');
  });
  afterAll(async () => db?.$disconnect());

  it("counts attempts atomically and blocks past the limit", async () => {
    const rule = { scope: `it:${Date.now()}`, limit: 5, windowSeconds: 600 };
    const results = await Promise.all(Array.from({ length: 8 }, () => hitRateLimit(rule, "same-user", { db })));
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    const blocked = results.filter((r) => !r.allowed);
    expect(blocked).toHaveLength(3);
    // Window is 600s and just started, whatever the server's timezone.
    for (const r of blocked) expect(r.retryAfterSeconds).toBeGreaterThan(590);
    for (const r of blocked) expect(r.retryAfterSeconds).toBeLessThanOrEqual(600);
  });

  it("starts a fresh window once the old one has expired", async () => {
    const rule = { scope: `it-exp:${Date.now()}`, limit: 1, windowSeconds: 60 };
    await hitRateLimit(rule, "u", { db });
    expect((await hitRateLimit(rule, "u", { db })).allowed).toBe(false);
    await db.$executeRawUnsafe(
      `update "RateLimitBucket" set "windowStart" = "windowStart" - interval '2 minutes' where "key" = $1`,
      rateLimitKey(rule.scope, "u")
    );
    expect((await hitRateLimit(rule, "u", { db })).allowed).toBe(true);
  });

  it("blocks when any one of several rules is exceeded", async () => {
    const tight = { scope: `it-a:${Date.now()}`, limit: 1, windowSeconds: 600 };
    const loose = { scope: `it-b:${Date.now()}`, limit: 100, windowSeconds: 600 };
    await hitRateLimits([[tight, "u"], [loose, "ip"]], { db });
    expect((await hitRateLimits([[tight, "u"], [loose, "ip"]], { db })).allowed).toBe(false);
  });
});
