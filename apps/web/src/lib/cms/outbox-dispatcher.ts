/** Server-only CMS outbox dispatcher: leased claim, signed v1 POST per enabled
 * target, per-target receipts, exponential backoff and dead-letter.
 * Matches mfts-2026 src/lib/marketing/revalidation.ts exactly. Logs carry only
 * event IDs, consumer IDs, status codes and fixed error codes: never secrets,
 * secret env names' values, URLs, request or response bodies. */
import { createHmac, randomUUID } from "node:crypto";

export const DISPATCH_TIMEOUT_MS = 5000;
export const MAX_RESPONSE_BYTES = 4096;
export const DEFAULT_LEASE_MS = 60_000;
export const DEFAULT_MAX_ATTEMPTS = 8;
export const DEFAULT_BATCH_SIZE = 10;
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_CAP_MS = 60 * 60_000;
const SECRET_ENV = /^CMS_DELIVERY_SECRET_[A-Z0-9_]{1,64}$/;
const SECRET_VALUE = /^[\x21-\x7e]{32,4096}$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type DeliveryErrorCode = "http_status" | "redirect" | "timeout" | "network" | "secret_unavailable" | "target_refused";
export type ClaimedEvent = { id: string; datasetId: string; attempts: number };
export type PendingTarget = { id: string; consumerId: string; url: string; secretEnv: string };
export type DeliveryResult = { ok: boolean; statusCode: number | null; error: DeliveryErrorCode | null };
export type FinishState = { status: "delivered" } | { status: "pending"; nextAttemptAt: Date } | { status: "failed" };

/** All writes after claim are fenced by the lease token; false means the lease was lost. */
export interface OutboxStore {
  claim(now: Date, leaseUntil: Date, leaseToken: string, limit: number): Promise<ClaimedEvent[]>;
  pendingTargets(event: ClaimedEvent): Promise<PendingTarget[]>;
  record(event: ClaimedEvent, leaseToken: string, target: PendingTarget, result: DeliveryResult, now: Date): Promise<boolean>;
  finish(event: ClaimedEvent, leaseToken: string, state: FinishState, now: Date): Promise<boolean>;
}

export type DispatchOptions = {
  env?: Record<string, string | undefined>;
  fetcher?: typeof fetch;
  now?: () => Date;
  leaseMs?: number;
  maxAttempts?: number;
  batchSize?: number;
  /** Test-only: honoured only when env.NODE_ENV === "test". */
  allowLoopbackHttp?: boolean;
  log?: (line: string) => void;
};
export type DispatchSummary = { enabled: boolean; claimed: number; delivered: number; retried: number; deadLettered: number; leaseLost: number };

export const revalidationEventBody = (eventId: string, datasetId: string) => JSON.stringify({ version: 1, eventId, datasetId });

export function signRevalidationEvent(secret: string, timestamp: string, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`v1.${timestamp}.`).update(body).digest("hex")}`;
}

export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (Math.max(1, Math.floor(attempt)) - 1));
}

export function dispatchEnabled(env: Record<string, string | undefined>): boolean {
  return env.CMS_OUTBOX_DISPATCH_ENABLED === "true";
}

/** Operator-configured destination only; mirrors the DB url check. */
export function targetUrl(raw: string, allowLoopbackHttp: boolean): URL | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (raw.length > 2048 || url.username || url.password || url.search || url.hash) return null;
  if (url.protocol === "https:") return url;
  return url.protocol === "http:" && allowLoopbackHttp && LOOPBACK.has(url.hostname) ? url : null;
}

export function targetSecret(secretEnv: string, env: Record<string, string | undefined>): string | null {
  if (!SECRET_ENV.test(secretEnv)) return null;
  const value = env[secretEnv];
  return typeof value === "string" && SECRET_VALUE.test(value) ? value : null;
}

async function drain(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return;
  const reader = body.getReader();
  let size = 0;
  try {
    while (size <= MAX_RESPONSE_BYTES) {
      const { value, done } = await reader.read();
      if (done) return;
      size += value.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

async function post(fetcher: typeof fetch, url: URL, secret: string, event: ClaimedEvent, now: Date): Promise<DeliveryResult> {
  const body = revalidationEventBody(event.id, event.datasetId);
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const signal = AbortSignal.timeout(DISPATCH_TIMEOUT_MS);
  try {
    const response = await fetcher(url, {
      method: "POST", body, redirect: "manual", signal,
      headers: { "content-type": "application/json", "x-jongo-timestamp": timestamp,
        "x-jongo-signature": signRevalidationEvent(secret, timestamp, body), "user-agent": "jongo-cms-outbox/1" },
    });
    await drain(response.body);
    if (response.status >= 200 && response.status < 300) return { ok: true, statusCode: response.status, error: null };
    return { ok: false, statusCode: response.status, error: response.status >= 300 && response.status < 400 ? "redirect" : "http_status" };
  } catch {
    return { ok: false, statusCode: null, error: signal.aborted ? "timeout" : "network" };
  }
}

export async function dispatchOutboxOnce(store: OutboxStore, options: DispatchOptions = {}): Promise<DispatchSummary> {
  const env = options.env ?? process.env;
  const summary: DispatchSummary = { enabled: dispatchEnabled(env), claimed: 0, delivered: 0, retried: 0, deadLettered: 0, leaseLost: 0 };
  if (!summary.enabled) return summary;
  const fetcher = options.fetcher ?? fetch;
  const clock = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const loopback = options.allowLoopbackHttp === true && env.NODE_ENV === "test";
  const leaseToken = randomUUID();
  const claimedAt = clock();
  const events = await store.claim(claimedAt, new Date(claimedAt.getTime() + leaseMs), leaseToken, options.batchSize ?? DEFAULT_BATCH_SIZE);
  summary.claimed = events.length;
  for (const event of events) {
    const targets = await store.pendingTargets(event);
    let lost = false, allOk = true;
    await Promise.all(targets.map(async target => {
      const url = targetUrl(target.url, loopback), secret = targetSecret(target.secretEnv, env);
      const result: DeliveryResult = !url ? { ok: false, statusCode: null, error: "target_refused" }
        : !secret ? { ok: false, statusCode: null, error: "secret_unavailable" }
        : await post(fetcher, url, secret, event, clock());
      if (!result.ok) allOk = false;
      if (!await store.record(event, leaseToken, target, result, clock())) lost = true;
      log(`[cms-outbox] event=${event.id} consumer=${target.consumerId} ${result.ok ? "delivered" : `failed=${result.error}`}${result.statusCode ? ` status=${result.statusCode}` : ""}`);
    }));
    const now = clock();
    const state: FinishState = allOk ? { status: "delivered" }
      : event.attempts >= maxAttempts ? { status: "failed" }
      : { status: "pending", nextAttemptAt: new Date(now.getTime() + backoffMs(event.attempts)) };
    if (lost || !await store.finish(event, leaseToken, state, now)) {
      summary.leaseLost += 1;
      log(`[cms-outbox] event=${event.id} lease lost; left for reclaim`);
      continue;
    }
    if (state.status === "delivered") summary.delivered += 1;
    else if (state.status === "failed") { summary.deadLettered += 1; log(`[cms-outbox] event=${event.id} dead-lettered after ${event.attempts} attempts`); }
    else summary.retried += 1;
  }
  return summary;
}

/** Minimal raw interface satisfied by PrismaClient; parameters are always bound. */
export type RawDb = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
};
const ts = (n: number) => `($${n}::timestamptz AT TIME ZONE 'UTC')`;

export function createPostgresOutboxStore(db: RawDb): OutboxStore {
  return {
    async claim(now, leaseUntil, leaseToken, limit) {
      // Reclaims expired leases; attempts count claims, so a crashing worker still dead-letters.
      return db.$queryRawUnsafe<ClaimedEvent[]>(`WITH due AS (
          SELECT o."id" FROM "CmsContentOutbox" o
          WHERE ((o."status" = 'pending' AND o."nextAttemptAt" <= ${ts(1)})
              OR (o."status" = 'processing' AND o."leaseUntil" < ${ts(1)}))
            AND EXISTS (SELECT 1 FROM "CmsDeliveryTarget" t WHERE t."datasetId" = o."datasetId" AND t."enabled")
          ORDER BY o."nextAttemptAt", o."createdAt", o."id"
          LIMIT $4::int
          FOR UPDATE OF o SKIP LOCKED)
        UPDATE "CmsContentOutbox" o SET "status" = 'processing', "leaseUntil" = ${ts(2)}, "leaseToken" = $3::uuid,
          "attempts" = o."attempts" + 1, "lastAttemptAt" = ${ts(1)}, "updatedAt" = ${ts(1)}
        FROM due WHERE o."id" = due."id"
        RETURNING o."id"::text AS "id", o."datasetId"::text AS "datasetId", o."attempts" AS "attempts"`,
      now.toISOString(), leaseUntil.toISOString(), leaseToken, limit);
    },
    async pendingTargets(event) {
      return db.$queryRawUnsafe<PendingTarget[]>(`SELECT t."id"::text AS "id", t."consumerId", t."url", t."secretEnv"
        FROM "CmsDeliveryTarget" t
        WHERE t."datasetId" = $1::uuid AND t."enabled" AND NOT EXISTS (
          SELECT 1 FROM "CmsContentDelivery" d WHERE d."eventId" = $2::uuid AND d."targetId" = t."id" AND d."status" = 'delivered')
        ORDER BY t."consumerId"`, event.datasetId, event.id);
    },
    async record(event, leaseToken, target, result, now) {
      const rows = await db.$queryRawUnsafe<unknown[]>(`INSERT INTO "CmsContentDelivery" AS d
          ("datasetId", "eventId", "targetId", "status", "attempts", "lastStatusCode", "lastError", "lastAttemptAt", "deliveredAt", "updatedAt")
        SELECT $1::uuid, $2::uuid, $3::uuid, $4::"CmsContentDeliveryStatus", 1, $5::int, $6::text, ${ts(7)},
          CASE WHEN $4::text = 'delivered' THEN ${ts(7)} END, ${ts(7)}
        WHERE EXISTS (SELECT 1 FROM "CmsContentOutbox" o WHERE o."id" = $2::uuid AND o."leaseToken" = $8::uuid AND o."status" = 'processing')
        ON CONFLICT ("eventId", "targetId") DO UPDATE SET "status" = EXCLUDED."status", "attempts" = d."attempts" + 1,
          "lastStatusCode" = EXCLUDED."lastStatusCode", "lastError" = EXCLUDED."lastError", "lastAttemptAt" = EXCLUDED."lastAttemptAt",
          "deliveredAt" = EXCLUDED."deliveredAt", "updatedAt" = EXCLUDED."updatedAt"
        WHERE d."status" = 'pending'
        RETURNING d."id"`,
      event.datasetId, event.id, target.id, result.ok ? "delivered" : "pending", result.statusCode, result.error, now.toISOString(), leaseToken);
      return rows.length === 1;
    },
    async finish(event, leaseToken, state, now) {
      const rows = await db.$queryRawUnsafe<Array<{ updated: number }>>(`WITH e AS (
          UPDATE "CmsContentOutbox" SET "status" = $3::"CmsContentOutboxStatus",
            "deliveredAt" = CASE WHEN $3::text = 'delivered' THEN ${ts(4)} END,
            "nextAttemptAt" = COALESCE(${ts(5)}, "nextAttemptAt"),
            "leaseUntil" = NULL, "leaseToken" = NULL, "updatedAt" = ${ts(4)}
          WHERE "id" = $1::uuid AND "leaseToken" = $2::uuid AND "status" = 'processing'
          RETURNING "id"),
        dead AS (
          UPDATE "CmsContentDelivery" d SET "status" = 'dead', "updatedAt" = ${ts(4)}
          FROM e WHERE $3::text = 'failed' AND d."eventId" = e."id" AND d."status" = 'pending'
          RETURNING d."id")
        SELECT (SELECT count(*) FROM e)::int AS "updated"`,
      event.id, leaseToken, state.status, now.toISOString(), state.status === "pending" ? state.nextAttemptAt.toISOString() : null);
      return rows[0]?.updated === 1;
    },
  };
}
