import { afterEach, describe, expect, it, vi } from "vitest";
import { retryOnceAfterRateLimit, retryOnceAfterRateLimitError } from "./rate-limit-retry";

describe("retryOnceAfterRateLimit", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits out a Coolify 429 and retries the same provisioning request", async () => {
    vi.useFakeTimers();
    const operation = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({ ok: true, status: 201 });

    const promise = retryOnceAfterRateLimit(operation, 60_000);

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ ok: true, status: 201 });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("does not retry ordinary unsupported endpoints", async () => {
    const operation = vi.fn().mockResolvedValue({ ok: false, status: 404 });

    await expect(retryOnceAfterRateLimit(operation)).resolves.toEqual({ ok: false, status: 404 });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("waits for the breaker cooldown when capability discovery throws a rate-limit error", async () => {
    vi.useFakeTimers();
    const operation = vi.fn()
      .mockRejectedValueOnce({ rateLimited: true, retryAfterMs: 34_000 })
      .mockResolvedValueOnce({ detected: true, applicationUuid: "staging-uuid" });

    const promise = retryOnceAfterRateLimitError(operation);

    await vi.advanceTimersByTimeAsync(33_999);
    expect(operation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toMatchObject({ applicationUuid: "staging-uuid" });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("does not retry unrelated capability errors", async () => {
    const error = new Error("fetch failed");
    const operation = vi.fn().mockRejectedValue(error);

    await expect(retryOnceAfterRateLimitError(operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
