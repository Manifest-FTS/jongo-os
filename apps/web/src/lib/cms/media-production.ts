import { getDb } from "@/lib/db";
import type { CmsMediaStore } from "./media";
import { createCmsMediaService } from "./media";
import { runMediaCleanupJob } from "./media-cleanup";
import { createS3CompatibleCmsMediaStore, purgeCloudflareMedia, readCloudflarePurgeConfig, readMediaCdnOrigin, readS3MediaConfig } from "./media-s3-store";

if (typeof window !== "undefined") throw new Error("CMS media production composition is server-only.");

/** Production-only composition. It has no filesystem/mock fallback and validates every
 * storage/CDN variable before returning a service. The env is process-owned, not request data. */
export function createProductionCmsMediaService(env: Record<string, string | undefined> = process.env) {
  const cdnOrigin = readMediaCdnOrigin(env);
  const adapter = () => createS3CompatibleCmsMediaStore(readS3MediaConfig(env));
  const store: CmsMediaStore = {
    putPrivate: (key, bytes) => adapter().putPrivate(key, bytes),
    getPrivate: key => adapter().getPrivate(key),
    promotePublic: key => adapter().promotePublic(key),
    getPublic: key => adapter().getPublic(key),
    publicUrl(key) { return `${cdnOrigin}/assets/${key}`; }
  };
  return createCmsMediaService(store, {
    publicOrigins: [cdnOrigin],
    cleanup: async cleanupJobId => {
      const db = await getDb();
      if (!db) return false;
      try {
        // Resolve CDN credentials only after the revocation + outbox transaction
        // committed, so missing credentials cannot leave an approved DB row.
        const s3 = readS3MediaConfig(env);
        const cloudflare = readCloudflarePurgeConfig(env);
        const b2 = createS3CompatibleCmsMediaStore(s3);
        return await runMediaCleanupJob(db, cleanupJobId, {
          deleteAllVersions: b2.deleteAllVersions,
          purge: url => purgeCloudflareMedia(url, cloudflare, fetch, s3.cdnOrigin)
        });
      } catch {
        // DB/provider detail and credentials are intentionally not surfaced or logged.
        return false;
      }
    }
  });
}
