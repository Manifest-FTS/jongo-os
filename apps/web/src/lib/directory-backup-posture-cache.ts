import { recordDirectoryBackupPostureCacheEvent } from "./diagnostics";

export type DirectoryBackupPosture = {
  localStatus: string;
  offsiteLabel: string;
  offsiteTone: "healthy" | "degraded" | "unknown";
  checkedAt?: string;
};

type DirectoryBackupPostureCacheEntry = {
  value?: DirectoryBackupPosture;
  cachedAtMs: number;
  inFlight?: Promise<DirectoryBackupPosture>;
};

const cache = new Map<string, DirectoryBackupPostureCacheEntry>();

export async function getCachedDirectoryBackupPosture(
  key: string,
  ttlMs: number,
  loader: () => Promise<DirectoryBackupPosture>
): Promise<DirectoryBackupPosture> {
  const nowMs = Date.now();
  const cached = cache.get(key);

  if (cached?.value && nowMs - cached.cachedAtMs < ttlMs) {
    recordDirectoryBackupPostureCacheEvent("hit");
    return cached.value;
  }

  if (cached?.inFlight) {
    recordDirectoryBackupPostureCacheEvent("in_flight_join");
    return cached.inFlight;
  }

  recordDirectoryBackupPostureCacheEvent("miss");

  const inFlight = (async (): Promise<DirectoryBackupPosture> => {
    try {
      const value = await loader();
      cache.set(key, {
        value,
        cachedAtMs: Date.now()
      });
      recordDirectoryBackupPostureCacheEvent("store");
      return value;
    } catch (error) {
      recordDirectoryBackupPostureCacheEvent("error");
      throw error;
    }
  })();

  cache.set(key, {
    ...cached,
    cachedAtMs: cached?.cachedAtMs ?? 0,
    inFlight
  });

  try {
    return await inFlight;
  } finally {
    const latest = cache.get(key);
    if (latest?.inFlight) {
      cache.set(key, {
        value: latest.value,
        cachedAtMs: latest.cachedAtMs
      });
    }
  }
}

export function resetDirectoryBackupPostureCache(): void {
  cache.clear();
}