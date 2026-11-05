/**
 * NDJSON import. Atomicity decision (documented in the README):
 *  - dry-run never writes; it returns the per-document outcome report.
 *  - apply is ALL-OR-NOTHING: it writes only when no document is `invalid` or `conflict`. Otherwise it writes nothing
 *    (no receipt, one audit row), returns `applied: false, blocked: true` with the same report, and the caller fixes the
 *    file or passes onConflict: 'skip'. Intentional skips (asset documents, system types, existing ids under
 *    onConflict: 'skip') never block.
 *  - Nothing is coerced: unknown types, invalid ids, invalid documents and malformed timestamps are reported, not repaired.
 *  - Existing ids conflict instead of being overwritten. Imported documents get a new `_rev`; `_createdAt`/`_updatedAt`
 *    are kept when well-formed. Asset documents and binaries are not stored; asset documents present in the file (and
 *    `assets` supplied by the host) only satisfy reference validation.
 */
import { requireAccess, type CraftContext } from './auth.js';
import {
  assertAssets, assertRegistry, buildReferenceIndex, collectReferences, ENVELOPE_KEYS, parseDocumentId, validateOrFail,
  type JsonObject, type Reference, type SchemaRegistry
} from './docs-core.js';
import { CraftError, fail, type ValidationIssue } from './errors.js';
import type { Queryable } from './executor.js';
import { canonicalJson, findJsonViolation, MAX_DOCUMENT_BYTES, sha256Hex } from './json.js';
import { isTimestamp, parseNdjson, type NdjsonLimits, type ParsedDocument } from './ndjson.js';
import { assertMutationKey, inTransaction, newRev, newUuid, resolveDataset, runMutation } from './store.js';
import type { TypeDefinition } from '../schema.js';

export type ImportEntry = { id: string; type: string; outcome: 'create' | 'skip' | 'conflict' | 'invalid'; reason?: string; issues?: ValidationIssue[] };
export type ImportSummary = { total: number; create: number; skip: number; conflict: number; invalid: number };
export type ImportResult = {
  mode: 'dry-run' | 'apply';
  /** true only when rows were committed by this call (or by the original call, on replay). */
  applied: boolean;
  /** apply only: nothing was written because a document was invalid or conflicted. */
  blocked: boolean;
  replayed: boolean;
  sha256: string; bytes: number; summary: ImportSummary;
  /** In file order. Empty on an idempotent replay (the receipt stores the summary only). */
  report: ImportEntry[];
};
export type ImportNdjsonInput = {
  dataset: string; registry: SchemaRegistry; bytes: Uint8Array; mode: 'dry-run' | 'apply';
  /** Default 'error': an existing id is a conflict. 'skip' reports it as skipped and leaves it untouched. Nothing is overwritten. */
  onConflict?: 'error' | 'skip';
  /** Required for 'apply'. */
  mutationKey?: string;
  /** Asset documents known to the host, used only for reference validation. */
  assets?: readonly JsonObject[];
  /** Defaults 10,000 documents / 32 MiB. */
  limits?: { maxDocuments?: number; maxBytes?: number };
};

type Candidate = {
  entry: ImportEntry; logical: string; native: string; variant: 'draft' | 'published'; type: string; schema: TypeDefinition;
  canonical: string; sha: string; body: JsonObject; refs: Reference[]; createdAt: string | null; updatedAt: string | null;
};
const CHUNK = 200;
const MAX_REPORT_ISSUES = 10;
const ASSET_TYPES = new Set(['sanity.imageAsset', 'sanity.fileAsset']);
const short = (value: string) => value.slice(0, 200);
const normalizeTime = (value: string) => new Date(value).toISOString();

type Plan = { entries: ImportEntry[]; creates: Candidate[]; blocked: boolean };

async function plan(q: Queryable, datasetId: string, input: { registry: SchemaRegistry; documents: ParsedDocument[]; onConflict: 'error' | 'skip'; assets: readonly JsonObject[] }): Promise<Plan> {
  const entries: ImportEntry[] = [];
  const candidates: Candidate[] = [];

  for (const doc of input.documents) {
    const entry: ImportEntry = { id: short(doc._id), type: short(doc._type), outcome: 'create' };
    entries.push(entry);
    const reject = (reason: string, outcome: 'skip' | 'invalid' = 'invalid') => { entry.outcome = outcome; entry.reason = reason; };
    if (doc._id.startsWith('versions.')) { reject('versions_not_supported', 'skip'); continue; }
    if (ASSET_TYPES.has(doc._type)) { reject('asset_not_supported', 'skip'); continue; }
    if (doc._type.startsWith('sanity.') || doc._type.startsWith('system.')) { reject('system_type_not_supported', 'skip'); continue; }
    let id;
    try { id = parseDocumentId(doc._id); } catch { reject('invalid_id'); continue; }
    const schema = input.registry.get(doc._type);
    if (!schema) { reject('unknown_type'); continue; }
    const created = doc._createdAt, updated = doc._updatedAt;
    if ((created !== undefined && !isTimestamp(created)) || (updated !== undefined && !isTimestamp(updated))) { reject('invalid_timestamp'); continue; }
    const body: JsonObject = {};
    for (const key of Object.keys(doc)) if (!(ENVELOPE_KEYS as readonly string[]).includes(key)) body[key] = doc[key];
    if (findJsonViolation(body)) { reject('unsafe_content'); continue; }
    const canonical = canonicalJson(body);
    if (Buffer.byteLength(canonical, 'utf8') > MAX_DOCUMENT_BYTES) { reject('too_large'); continue; }
    const candidate: Candidate = {
      entry, logical: id.logical, native: id.native, variant: id.variant, type: schema.name, schema, canonical, sha: sha256Hex(canonical), body, refs: [],
      createdAt: created ? normalizeTime(created as string) : null, updatedAt: updated ? normalizeTime(updated as string) : null
    };
    try { candidate.refs = collectReferences(body); } catch { reject('too_large'); continue; }
    candidates.push(candidate);
  }

  // Draft and published variants of one id must share a type, within the file and against stored rows.
  const typeOf = new Map<string, string>();
  for (const c of candidates) {
    const known = typeOf.get(c.logical);
    if (known !== undefined && known !== c.type) for (const other of candidates.filter(o => o.logical === c.logical)) { other.entry.outcome = 'invalid'; other.entry.reason = 'type_mismatch'; }
    typeOf.set(c.logical, c.type);
  }
  const existing = new Map<string, { native: Set<string>; type: string }>();
  if (candidates.length) {
    const found = await q.query<{ native_id: string; type: string; logical_id: string }>(
      'SELECT native_id, type, logical_id FROM craft.documents WHERE dataset_id = $1 AND logical_id = ANY($2::text[])', [datasetId, [...new Set(candidates.map(c => c.logical))]]);
    for (const row of found.rows) {
      const slot = existing.get(row.logical_id) ?? { native: new Set<string>(), type: row.type };
      slot.native.add(row.native_id);
      existing.set(row.logical_id, slot);
    }
  }
  for (const c of candidates) {
    if (c.entry.outcome !== 'create') continue;
    const stored = existing.get(c.logical);
    if (stored?.native.has(c.native)) {
      if (input.onConflict === 'skip') { c.entry.outcome = 'skip'; c.entry.reason = 'exists'; } else { c.entry.outcome = 'conflict'; c.entry.reason = 'exists'; }
    } else if (stored && stored.type !== c.type) { c.entry.outcome = 'invalid'; c.entry.reason = 'type_mismatch'; }
  }

  // Validation with Craft's own validator. The index sees every document in the file (assets and other skipped types included).
  const inFile = input.documents.map(d => ({ _id: d._id, _type: d._type }));
  const targets = candidates.filter(c => c.entry.outcome === 'create').flatMap(c => c.refs.map(r => r.target));
  const index = await buildReferenceIndex(q, datasetId, targets, inFile, input.assets);
  for (const c of candidates) {
    if (c.entry.outcome !== 'create') continue;
    try { validateOrFail(c.schema, { ...c.body, _id: c.logical, _type: c.type }, index, c.variant === 'draft' ? 'draft' : 'publish'); } catch (error) {
      if (!(error instanceof CraftError) || error.code !== 'validation_failed') throw error;
      c.entry.outcome = 'invalid'; c.entry.reason = 'validation_failed';
      c.entry.issues = (error.issues ?? []).slice(0, MAX_REPORT_ISSUES);
    }
  }
  const blocked = entries.some(e => e.outcome === 'conflict' || e.outcome === 'invalid');
  return { entries, creates: candidates.filter(c => c.entry.outcome === 'create'), blocked };
}

async function write(q: Queryable, datasetId: string, actorId: string, creates: Candidate[]): Promise<void> {
  for (let i = 0; i < creates.length; i += CHUNK) {
    const chunk = creates.slice(i, i + CHUNK).map(c => ({ c, doc: newUuid(), rev: newUuid() }));
    await q.query(
      `INSERT INTO craft.documents (id, dataset_id, native_id, type, logical_id, variant, created_at, updated_at)
       SELECT x.id, $1, x.native_id, x.type, x.logical_id, x.variant, coalesce(x.created_at, now()), coalesce(x.updated_at, x.created_at, now())
       FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::timestamptz[], $8::timestamptz[]) AS x(id, native_id, type, logical_id, variant, created_at, updated_at)`,
      [datasetId, chunk.map(k => k.doc), chunk.map(k => k.c.native), chunk.map(k => k.c.type), chunk.map(k => k.c.logical), chunk.map(k => k.c.variant), chunk.map(k => k.c.createdAt), chunk.map(k => k.c.updatedAt)]);
    await q.query(
      `INSERT INTO craft.revisions (id, dataset_id, document_id, sequence, schema_version, native_rev, payload, payload_sha256, actor_id, created_at)
       SELECT x.id, $1, x.document_id, 1, x.schema_version, x.native_rev, x.payload::jsonb, x.sha, $2, coalesce(x.created_at, x.fallback, now())
       FROM unnest($3::uuid[], $4::uuid[], $5::int[], $6::text[], $7::text[], $8::text[], $9::timestamptz[], $10::timestamptz[]) AS x(id, document_id, schema_version, native_rev, payload, sha, created_at, fallback)`,
      [datasetId, actorId, chunk.map(k => k.rev), chunk.map(k => k.doc), chunk.map(k => k.c.schema.schemaVersion), chunk.map(() => newRev()), chunk.map(k => k.c.canonical), chunk.map(k => k.c.sha), chunk.map(k => k.c.updatedAt), chunk.map(k => k.c.createdAt)]);
    await q.query(
      `UPDATE craft.documents d SET current_revision_id = x.rev, lock_version = 1
       FROM unnest($2::uuid[], $3::uuid[]) AS x(doc, rev) WHERE d.dataset_id = $1 AND d.id = x.doc`, [datasetId, chunk.map(k => k.doc), chunk.map(k => k.rev)]);
    const refs = chunk.flatMap(k => k.c.refs.map(r => ({ rev: k.rev, ...r })));
    if (refs.length) {
      await q.query(
        `INSERT INTO craft."references" (dataset_id, revision_id, path, target_native_id, weak)
         SELECT $1, x.rev, x.p, x.t, x.w FROM unnest($2::uuid[], $3::text[], $4::text[], $5::boolean[]) AS x(rev, p, t, w)`,
        [datasetId, refs.map(r => r.rev), refs.map(r => r.path), refs.map(r => r.target), refs.map(r => r.weak)]);
    }
  }
}

function summarize(entries: readonly ImportEntry[]): ImportSummary {
  const summary: ImportSummary = { total: entries.length, create: 0, skip: 0, conflict: 0, invalid: 0 };
  for (const e of entries) summary[e.outcome]++;
  return summary;
}

/** Needs 'import' (dry-run included). See the file comment for atomicity and conflict rules. */
export async function importNdjson(ctx: CraftContext, options: ImportNdjsonInput): Promise<ImportResult> {
  if (options?.mode !== 'dry-run' && options?.mode !== 'apply') return fail('invalid_options');
  const onConflict = options.onConflict ?? 'error';
  if (onConflict !== 'error' && onConflict !== 'skip') return fail('invalid_options');
  if (!(options.bytes instanceof Uint8Array)) return fail('invalid_options');
  await requireAccess(ctx, options.dataset, 'import');
  assertRegistry(options.registry);
  const assets = assertAssets(options.assets);
  if (options.mode === 'apply') assertMutationKey(options.mutationKey);
  const limits: Partial<NdjsonLimits> = {};
  if (options.limits?.maxDocuments !== undefined) limits.maxDocuments = options.limits.maxDocuments;
  if (options.limits?.maxBytes !== undefined) limits.maxTotalBytes = options.limits.maxBytes;
  const parsed = parseNdjson(options.bytes, { limits });
  const base = { sha256: parsed.stats.sha256, bytes: parsed.stats.bytes };
  const planInput = { registry: options.registry, documents: parsed.documents, onConflict, assets };

  if (options.mode === 'dry-run') {
    return inTransaction(ctx, async q => {
      const dataset = await resolveDataset(q, options.dataset);
      const planned = await plan(q, dataset.id, planInput);
      return { mode: 'dry-run' as const, applied: false, blocked: planned.blocked, replayed: false, ...base, summary: summarize(planned.entries), report: planned.entries };
    }, { snapshot: true });
  }

  return runMutation<Record<string, unknown>>(ctx, {
    dataset: options.dataset, action: 'import', operation: 'importNdjson', key: options.mutationKey, authorized: true,
    request: { sha256: base.sha256, onConflict },
    async work(q, dataset) {
      await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`craft:import:${dataset.id}`]);
      const planned = await plan(q, dataset.id, planInput);
      const summary = summarize(planned.entries);
      const result = { mode: 'apply', applied: !planned.blocked, blocked: planned.blocked, ...base, summary };
      if (planned.blocked) {
        return { result, response: { ...result, report: planned.entries }, record: false, audit: { action: 'import.blocked', detail: { ...summary, sha256: base.sha256 } } };
      }
      await write(q, dataset.id, ctx.actorId, planned.creates);
      return { result, response: { ...result, report: planned.entries }, audit: { action: 'import.apply', detail: { ...summary, sha256: base.sha256, onConflict } } };
    }
  }).then(out => ({ report: [], ...out }) as unknown as ImportResult);
}
