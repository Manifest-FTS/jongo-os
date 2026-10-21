import { randomUUID } from "node:crypto";
import { readCloudflarePurgeConfig, purgeCloudflareMedia, readS3MediaConfig, createS3CompatibleCmsMediaStore } from "./media-s3-store";

if (typeof window !== "undefined") throw new Error("CMS media cleanup is server-only.");
const ts = (n: number) => `($${n}::timestamptz AT TIME ZONE 'UTC')`;
export type CleanupDb = { $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>; $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> };
export type CleanupProvider = { deleteAllVersions(key: string): Promise<void>; purge(url: string): Promise<void> };
export type CleanupJob = { id: string; datasetId: string; mediaId: string; objectKey: string; publicUrl: string; attempts: number };
export type CleanupErrorCode = "provider_unavailable" | "cdn_purge_unavailable" | "invalid_configuration";
export const MEDIA_CLEANUP_MAX_BATCH = 10;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 60 * 60_000;

export function mediaCleanupBackoffMs(attempt: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (Math.max(1, Math.floor(attempt)) - 1));
}

/** Claim with SKIP LOCKED and a lease. Provider calls happen after the claim transaction. */
export async function claimMediaCleanupJobs(db: CleanupDb, now = new Date(), limit = MEDIA_CLEANUP_MAX_BATCH, onlyId?: string): Promise<CleanupJob[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MEDIA_CLEANUP_MAX_BATCH) throw new Error("Invalid media cleanup batch size.");
  const lease = randomUUID();
  return db.$queryRawUnsafe<CleanupJob[]>(`WITH due AS (
      SELECT j."id" FROM "CmsMediaCleanupJob" j
      WHERE (($4::uuid IS NULL AND ((j."status" = 'pending' AND j."nextAttemptAt" <= ${ts(1)}) OR
              (j."status" = 'processing' AND j."leaseUntil" < ${ts(1)}))) OR
             ($4::uuid IS NOT NULL AND j."id" = $4::uuid AND
              (j."status" = 'pending' OR (j."status" = 'processing' AND j."leaseUntil" < ${ts(1)}))))
      ORDER BY j."nextAttemptAt", j."createdAt", j."id" LIMIT $3::int FOR UPDATE SKIP LOCKED)
    UPDATE "CmsMediaCleanupJob" j SET "status" = 'processing', "leaseUntil" = ${ts(2)}, "leaseToken" = $5::uuid,
      "attempts" = j."attempts" + 1, "updatedAt" = ${ts(1)}
    FROM due WHERE j."id" = due."id"
    RETURNING j."id"::text AS "id", j."datasetId"::text AS "datasetId", j."mediaId"::text AS "mediaId",
      j."objectKey", j."publicUrl", j."attempts"`, now.toISOString(), new Date(now.getTime() + 60_000).toISOString(), limit, onlyId ?? null, lease)
    .then(rows => rows.map(row => ({ ...row, leaseToken: lease } as CleanupJob & { leaseToken: string })));
}

async function recordOutcome(db: CleanupDb, job: CleanupJob & { leaseToken: string }, now: Date,
  state: "complete" | "pending", code: CleanupErrorCode | null): Promise<boolean> {
  const next = new Date(now.getTime() + mediaCleanupBackoffMs(job.attempts));
  const rows = await db.$queryRawUnsafe<Array<{ completed: number }>>(`WITH updated AS (
      UPDATE "CmsMediaCleanupJob" SET "status" = $3::"CmsMediaCleanupStatus", "completedAt" = CASE WHEN $3 = 'complete' THEN ${ts(4)} END,
        "nextAttemptAt" = CASE WHEN $3 = 'pending' THEN ${ts(5)} ELSE "nextAttemptAt" END,
        "lastError" = $6::text, "leaseUntil" = NULL, "leaseToken" = NULL, "updatedAt" = ${ts(4)}
      WHERE "id" = $1::uuid AND "leaseToken" = $2::uuid AND "status" = 'processing'
      RETURNING "datasetId", "mediaId", "attempts")
    INSERT INTO "AuditLog" ("organizationId", "actorId", action, "resourceType", "resourceId", details)
    SELECT d."organizationId", NULL, CASE WHEN $3 = 'complete' THEN 'cms.media.cleanup.complete' ELSE 'cms.media.cleanup.retry' END,
      'cms_media', u."mediaId"::text, jsonb_build_object('cleanupJobId', $1::uuid, 'attempt', u."attempts", 'outcome', $3::text, 'errorCode', $6::text)
    FROM updated u JOIN "CmsDataset" d ON d.id = u."datasetId" RETURNING 1 AS completed`,
    job.id, job.leaseToken, state, now.toISOString(), next.toISOString(), code);
  return rows.length === 1;
}

export async function runMediaCleanupJob(db: CleanupDb, jobId: string, provider: CleanupProvider,
  now = new Date()): Promise<boolean> {
  const jobs = await claimMediaCleanupJobs(db, now, 1, jobId);
  const job = jobs[0] as (CleanupJob & { leaseToken: string }) | undefined;
  if (!job) {
    const rows = await db.$queryRawUnsafe<Array<{ status: string }>>(
      `SELECT "status"::text AS "status" FROM "CmsMediaCleanupJob" WHERE "id" = $1::uuid`, jobId);
    return rows[0]?.status === "complete";
  }
  let errorCode: CleanupErrorCode | null = null;
  try {
    await provider.deleteAllVersions(job.objectKey);
  } catch { errorCode = "provider_unavailable"; }
  if (!errorCode) {
    try { await provider.purge(job.publicUrl); }
    catch { errorCode = "cdn_purge_unavailable"; }
  }
  const recorded = await recordOutcome(db, job, now, errorCode ? "pending" : "complete", errorCode);
  return recorded && !errorCode;
}

export async function dispatchMediaCleanupOnce(db: CleanupDb, env = process.env, now = new Date()): Promise<{ claimed: number; completed: number; retried: number }> {
  const jobs = await claimMediaCleanupJobs(db, now);
  let completed = 0, retried = 0;
  let provider: CleanupProvider | null = null;
  let configurationFailed = false;
  try {
    const s3 = readS3MediaConfig(env);
    const cf = readCloudflarePurgeConfig(env);
    const store = createS3CompatibleCmsMediaStore(s3);
    provider = { deleteAllVersions: store.deleteAllVersions, purge: url => purgeCloudflareMedia(url, cf, fetch, s3.cdnOrigin) };
  } catch { configurationFailed = true; }
  for (const job of jobs as Array<CleanupJob & { leaseToken: string }>) {
    let code: CleanupErrorCode | null = configurationFailed ? "invalid_configuration" : null;
    if (provider && !code) {
      try { await provider.deleteAllVersions(job.objectKey); }
      catch { code = "provider_unavailable"; }
      if (!code) {
        try { await provider.purge(job.publicUrl); }
        catch { code = "cdn_purge_unavailable"; }
      }
    }
    if (await recordOutcome(db, job, now, code ? "pending" : "complete", code)) {
      if (code) retried += 1; else completed += 1;
    }
  }
  return { claimed: jobs.length, completed, retried };
}
