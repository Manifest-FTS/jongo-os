import { beforeEach, describe, expect, it } from "vitest";
import {
  CoolifyHttpError,
  isNotFoundError,
  CoolifyRateLimitError,
  isRateLimitError,
  isRateLimited,
  noteRateLimited,
  rateLimitCooldownRemaining,
  resetRateLimit
} from "./coolify-rate-limit";

beforeEach(() => resetRateLimit());

describe("CoolifyRateLimitError", () => {
  it("is identifiable, so a 429 is never mistaken for a factual answer", () => {
    // The whole point: callers must be able to tell "Coolify was busy" apart
    // from "this resource does not exist".
    const err = new CoolifyRateLimitError(60_000);
    expect(isRateLimitError(err)).toBe(true);
    expect(isRateLimitError(new Error("Not found"))).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError({ rateLimited: true })).toBe(true);
  });

  it("reports how long to wait", () => {
    expect(new CoolifyRateLimitError(30_000).retryAfterMs).toBe(30_000);
  });
});

describe("the breaker", () => {
  const now = 1_000_000;

  it("is closed until a 429 is seen", () => {
    expect(isRateLimited(now)).toBe(false);
    expect(rateLimitCooldownRemaining(now)).toBe(0);
  });

  it("opens for a full window when Coolify sends no Retry-After", () => {
    noteRateLimited(null, now);
    expect(isRateLimited(now)).toBe(true);
    expect(rateLimitCooldownRemaining(now)).toBe(60_000);
  });

  it("honours Retry-After when provided", () => {
    noteRateLimited(15, now);
    expect(rateLimitCooldownRemaining(now)).toBe(15_000);
  });

  it("closes once the window has passed", () => {
    noteRateLimited(10, now);
    expect(isRateLimited(now + 9_000)).toBe(true);
    expect(isRateLimited(now + 11_000)).toBe(false);
  });

  it("extends rather than shortens when a later 429 arrives", () => {
    noteRateLimited(60, now);
    noteRateLimited(5, now + 1_000);
    // A short Retry-After must not cancel a longer cooldown already in effect.
    expect(rateLimitCooldownRemaining(now + 1_000)).toBe(59_000);
  });

  it("caps an absurd Retry-After so a bad header cannot wedge the platform", () => {
    noteRateLimited(86_400, now);
    expect(rateLimitCooldownRemaining(now)).toBe(5 * 60_000);
  });

  it("ignores nonsense Retry-After values and falls back to a window", () => {
    for (const value of [0, -5, Number.NaN, "abc" as unknown as number]) {
      resetRateLimit();
      noteRateLimited(value, now);
      expect(rateLimitCooldownRemaining(now)).toBe(60_000);
    }
  });
});

describe("CoolifyHttpError", () => {
  it("distinguishes a 404 from a failure to ask", () => {
    // Probing "is this a service?" is done by fetching it, so a 404 is the
    // answer "no". Treating it as doubt made every ordinary application
    // undetermined forever, so nothing could be cached.
    expect(isNotFoundError(new CoolifyHttpError(404, "/api/v1/services/x"))).toBe(true);
    expect(isNotFoundError(new CoolifyHttpError(500, "/api/v1/services/x"))).toBe(false);
    expect(isNotFoundError(new CoolifyRateLimitError(60_000))).toBe(false);
    expect(isNotFoundError(new Error("boom"))).toBe(false);
    expect(isNotFoundError(null)).toBe(false);
  });

  it("carries the status for callers to branch on", () => {
    expect(new CoolifyHttpError(404, "/p").status).toBe(404);
    expect(new CoolifyHttpError(503, "/p").status).toBe(503);
  });

  it("is not mistaken for a rate limit", () => {
    expect(isRateLimitError(new CoolifyHttpError(404, "/p"))).toBe(false);
  });
});
