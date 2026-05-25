import { recordDirectoryStagingPostureCacheEvent } from "./diagnostics";

export type DirectoryStagingPosture = {
  environmentReady: boolean;
  targetAttached: boolean;
  checkedAt?: string;
};

type DirectoryStagingPostureCacheEntry = {
  value?: DirectoryStagingPosture;
  cachedAtMs: number;
  inFlight?: Promise<DirectoryStagingPosture>;
};

const cache = new Map<string, DirectoryStagingPostureCacheEntry>();

export async function getCachedDirectoryStagingPosture(
  key: string,
  ttlMs: number,
  loader: () => Promise<DirectoryStagingPosture>
): Promise<DirectoryStagingPosture> {
  const nowMs = Date.now();
  const cached = cache.get(key);

  if (cached?.value && nowMs - cached.cachedAtMs < ttlMs) {
    recordDirectoryStagingPostureCacheEvent("hit", key);
    return cached.value;
  }

  if (cached?.inFlight) {
    recordDirectoryStagingPostureCacheEvent("in_flight_join", key);
    return cached.inFlight;
  }

  recordDirectoryStagingPostureCacheEvent("miss", key);

  const inFlight = (async (): Promise<DirectoryStagingPosture> => {
    try {
      const value = await loader();
      cache.set(key, {
        value,
        cachedAtMs: Date.now()
      });
      recordDirectoryStagingPostureCacheEvent("store", key);
      return value;
    } catch (error) {
      recordDirectoryStagingPostureCacheEvent("error", key);
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

export function resetDirectoryStagingPostureCache(): void {
  cache.clear();
}
