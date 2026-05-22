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
    return cached.value;
  }

  if (cached?.inFlight) {
    return cached.inFlight;
  }

  const inFlight = (async (): Promise<DirectoryBackupPosture> => {
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

export function resetDirectoryBackupPostureCache(): void {
  cache.clear();
}