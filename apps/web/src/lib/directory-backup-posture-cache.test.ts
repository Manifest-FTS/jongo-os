import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DirectoryBackupPosture,
  getCachedDirectoryBackupPosture,
  resetDirectoryBackupPostureCache
} from "./directory-backup-posture-cache";

afterEach(() => {
  resetDirectoryBackupPostureCache();
  vi.useRealTimers();
});

describe("getCachedDirectoryBackupPosture", () => {
  it("returns cached value within TTL without reloading", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T12:00:00.000Z"));

    const loader = vi
      .fn<() => Promise<DirectoryBackupPosture>>()
      .mockResolvedValue({
        localStatus: "Protected (recent)",
        offsiteLabel: "Local only",
        offsiteTone: "degraded",
        checkedAt: "2026-05-22T12:00:00.000Z"
      });

    const first = await getCachedDirectoryBackupPosture("app-1", 60_000, loader);
    vi.advanceTimersByTime(10_000);
    const second = await getCachedDirectoryBackupPosture("app-1", 60_000, loader);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("reloads after TTL expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T12:00:00.000Z"));

    const loader = vi
      .fn<() => Promise<DirectoryBackupPosture>>()
      .mockResolvedValueOnce({
        localStatus: "Protected (recent)",
        offsiteLabel: "Local only",
        offsiteTone: "degraded",
        checkedAt: "2026-05-22T12:00:00.000Z"
      })
      .mockResolvedValueOnce({
        localStatus: "Protected (stale)",
        offsiteLabel: "Configured",
        offsiteTone: "healthy",
        checkedAt: "2026-05-22T12:02:00.000Z"
      });

    await getCachedDirectoryBackupPosture("app-1", 60_000, loader);
    vi.advanceTimersByTime(61_000);
    const second = await getCachedDirectoryBackupPosture("app-1", 60_000, loader);

    expect(loader).toHaveBeenCalledTimes(2);
    expect(second.localStatus).toBe("Protected (stale)");
  });

  it("dedupes concurrent in-flight loads", async () => {
    const loader = vi.fn<() => Promise<DirectoryBackupPosture>>(
      async () =>
        await new Promise<DirectoryBackupPosture>((resolve) =>
          setTimeout(
            () =>
              resolve({
                localStatus: "Not protected",
                offsiteLabel: "Unknown",
                offsiteTone: "unknown",
                checkedAt: "2026-05-22T12:00:00.000Z"
              }),
            10
          )
        )
    );

    const [first, second] = await Promise.all([
      getCachedDirectoryBackupPosture("app-1", 60_000, loader),
      getCachedDirectoryBackupPosture("app-1", 60_000, loader)
    ]);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });
});