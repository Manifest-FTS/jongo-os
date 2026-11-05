import type { Queryable } from './executor.js';
import { fail } from './errors.js';
import type { QueryDocument } from './query/groq.js';
import { TS } from './store.js';

/** Total payload text a single query/export may load. The whole dataset is read into memory: this is the guard. */
export const MAX_DATASET_BYTES = 64 * 1024 * 1024;

/**
 * Every live document (both variants) with its current payload, as envelope documents. Must run inside a snapshot
 * transaction so the size check and the read agree. Refuses, never truncates, when the dataset is over a limit.
 */
export async function loadDatasetDocuments(q: Queryable, datasetId: string, limits: { maxDocuments: number; maxBytes?: number }): Promise<QueryDocument[]> {
  const FROM = `FROM craft.documents d JOIN craft.revisions r ON r.dataset_id = d.dataset_id AND r.document_id = d.id AND r.id = d.current_revision_id
    WHERE d.dataset_id = $1 AND d.archived_at IS NULL`;
  const size = await q.query<{ n: string; bytes: string }>(`SELECT count(*) AS n, coalesce(sum(octet_length(r.payload::text)), 0) AS bytes ${FROM}`, [datasetId]);
  if (Number(size.rows[0].n) > limits.maxDocuments || Number(size.rows[0].bytes) > (limits.maxBytes ?? MAX_DATASET_BYTES)) return fail('dataset_too_large');
  const rows = await q.query<{ native_id: string; type: string; native_rev: string; payload: Record<string, unknown>; created_at: string; updated_at: string }>(
    `SELECT d.native_id, d.type, r.native_rev, r.payload, ${TS('d.created_at')} AS created_at, ${TS('r.created_at')} AS updated_at ${FROM} ORDER BY d.native_id`, [datasetId]);
  return rows.rows.map(row => ({ ...row.payload, _id: row.native_id, _type: row.type, _rev: row.native_rev, _createdAt: row.created_at, _updatedAt: row.updated_at }));
}
