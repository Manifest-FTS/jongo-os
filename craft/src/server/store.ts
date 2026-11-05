/** Internal SQL helpers shared by the service modules. Fixed statements, positional parameters only. */
import { randomUUID } from 'node:crypto';
import { requireAccess, type CraftAction, type CraftContext } from './auth.js';
import { fail, toCraftError } from './errors.js';
import type { Queryable, TransactionOptions } from './executor.js';
import { canonicalJson, sha256Hex } from './json.js';
import { redact } from './redact.js';

export const TS = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const SETTINGS = `SELECT set_config('lock_timeout', '10s', true), set_config('statement_timeout', '60s', true)`;
const MAX_ATTEMPTS = 3;
const MUTATION_KEY = /^[A-Za-z0-9._:/@+=~-]{1,128}$/;

const isRetryable = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { code?: unknown; constraint?: unknown };
  return e.code === '40001' || e.code === '40P01' || (e.code === '23505' && e.constraint === 'mutations_dataset_key_key');
};

/** One transaction with local lock/statement timeouts, retried up to 3 attempts on serialization failure, deadlock and receipt-key races. */
export async function inTransaction<T>(ctx: CraftContext, fn: (q: Queryable) => Promise<T>, options?: TransactionOptions): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await ctx.executor.transaction(async q => { await q.query(SETTINGS); return fn(q); }, options);
    } catch (error) {
      if (attempt < MAX_ATTEMPTS && isRetryable(error)) continue;
      throw toCraftError(error);
    }
  }
}

export type DatasetRow = { id: string; name: string };
export async function resolveDataset(q: Queryable, name: string): Promise<DatasetRow> {
  const found = await q.query<DatasetRow>('SELECT id, name FROM craft.datasets WHERE name = $1 AND archived_at IS NULL', [name]);
  return found.rows[0] ?? fail('not_found');
}

export async function audit(q: Queryable, ctx: CraftContext, entry: { action: string; datasetId: string | null; documentId?: string | null; detail?: unknown }): Promise<void> {
  await q.query(
    'INSERT INTO craft.audit_log (actor_id, action, dataset_id, document_id, detail) VALUES ($1, $2, $3, $4, $5::jsonb)',
    [ctx.actorId, entry.action, entry.datasetId, entry.documentId ?? null, JSON.stringify(redact(entry.detail ?? {}))]
  );
}

export function assertMutationKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || !MUTATION_KEY.test(key)) fail('invalid_input');
}

export type MutationOutcome = {
  /** Stored in the receipt (small, bounded). */
  result: Record<string, unknown>;
  /** Returned to the caller instead of `result` when set (not stored). */
  response?: Record<string, unknown>;
  /** false: audit but write no receipt, so the same key can be retried after the cause is fixed. */
  record?: boolean;
  audit: { action: string; documentId?: string | null; detail?: unknown };
};
/**
 * Authorize, then one transaction: dataset lookup, per-key advisory lock, receipt lookup, work, receipt, audit.
 * The same key with the same actor/operation/request returns the stored result (replayed: true); the same key with
 * a different request fails with idempotency_conflict. The advisory lock makes a concurrent duplicate wait and then replay
 * instead of failing the compare-and-set of the work that already succeeded.
 */
export async function runMutation<T extends Record<string, unknown>>(ctx: CraftContext, spec: {
  dataset: string; action: CraftAction; operation: string; key: unknown; request: unknown;
  /** The caller already ran requireAccess for `action` (so the host is asked once, before inputs are inspected). */
  authorized?: boolean;
  work: (q: Queryable, dataset: DatasetRow) => Promise<MutationOutcome>;
}): Promise<T & { replayed: boolean }> {
  if (!spec.authorized) await requireAccess(ctx, spec.dataset, spec.action);
  assertMutationKey(spec.key);
  const key = spec.key;
  const requestSha = sha256Hex(canonicalJson({ operation: spec.operation, actor: ctx.actorId, dataset: spec.dataset, request: spec.request }));
  return inTransaction(ctx, async q => {
    const dataset = await resolveDataset(q, spec.dataset);
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`craft:mutation:${dataset.id}:${key}`]);
    const existing = await q.query<{ request_sha256: string; result: T }>('SELECT request_sha256, result FROM craft.mutations WHERE dataset_id = $1 AND key = $2', [dataset.id, key]);
    if (existing.rows[0]) {
      if (existing.rows[0].request_sha256 !== requestSha) return fail('idempotency_conflict');
      return { ...existing.rows[0].result, replayed: true };
    }
    const outcome = await spec.work(q, dataset);
    if (outcome.record !== false) {
      await q.query(
        'INSERT INTO craft.mutations (dataset_id, actor_id, key, operation, request_sha256, result) VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
        [dataset.id, ctx.actorId, key, spec.operation, requestSha, JSON.stringify(outcome.result)]
      );
    }
    await audit(q, ctx, { action: outcome.audit.action, datasetId: dataset.id, documentId: outcome.audit.documentId, detail: outcome.audit.detail });
    return { ...(outcome.response ?? outcome.result), replayed: false } as T & { replayed: boolean };
  });
}

export const newUuid = (): string => randomUUID();
export const newRev = (): string => randomUUID().replace(/-/g, '');
