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
    return cached.value;
  }

  if (cached?.inFlight) {
    return cached.inFlight;
  }

  const inFlight = (async (): Promise<DirectoryStagingPosture> => {
    const value = await loader();
    cache.set(key, {
      value,
      cachedAtMs: Date.now()
    });
    return value;
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
