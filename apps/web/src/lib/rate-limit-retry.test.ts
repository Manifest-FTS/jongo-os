import { afterEach, describe, expect, it, vi } from "vitest";
import { retryOnceAfterRateLimit } from "./rate-limit-retry";

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
});
