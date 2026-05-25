import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCachedDirectoryStagingPosture,
  resetDirectoryStagingPostureCache
} from "./directory-staging-posture-cache";

afterEach(() => {
  resetDirectoryStagingPostureCache();
  vi.useRealTimers();
});

describe("getCachedDirectoryStagingPosture", () => {
  it("returns cached value within TTL without reloading", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T12:00:00.000Z"));

    const loader = vi
      .fn()
      .mockResolvedValue({
        environmentReady: true,
        targetAttached: false,
        checkedAt: "2026-05-22T12:00:00.000Z"
      });

    const first = await getCachedDirectoryStagingPosture("app-1", 60_000, loader);
    vi.advanceTimersByTime(10_000);
    const second = await getCachedDirectoryStagingPosture("app-1", 60_000, loader);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("reloads after TTL expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T12:00:00.000Z"));

    const loader = vi
      .fn()
      .mockResolvedValueOnce({
        environmentReady: true,
        targetAttached: false,
        checkedAt: "2026-05-22T12:00:00.000Z"
      })
      .mockResolvedValueOnce({
        environmentReady: true,
        targetAttached: true,
        checkedAt: "2026-05-22T12:02:00.000Z"
      });

    await getCachedDirectoryStagingPosture("app-1", 60_000, loader);
    vi.advanceTimersByTime(61_000);
    const second = await getCachedDirectoryStagingPosture("app-1", 60_000, loader);

    expect(loader).toHaveBeenCalledTimes(2);
    expect(second.targetAttached).toBe(true);
  });

  it("dedupes concurrent in-flight loads", async () => {
    const loader = vi.fn(
      async () =>
        await new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                environmentReady: false,
                targetAttached: false,
                checkedAt: "2026-05-22T12:00:00.000Z"
              }),
            10
          )
        )
    );

    const [first, second] = await Promise.all([
      getCachedDirectoryStagingPosture("app-1", 60_000, loader),
      getCachedDirectoryStagingPosture("app-1", 60_000, loader)
    ]);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });
});
