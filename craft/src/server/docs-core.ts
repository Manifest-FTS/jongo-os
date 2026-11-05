/** Internal helpers for document services: identity rules, preparation, references, row access. */
import type { TypeDefinition } from '../schema.js';
import { createReferenceIndex, type ReferenceIndex } from '../content-ops.js';
import { validateDocument, type Issue } from '../validate.js';
import { CraftError, fail } from './errors.js';
import type { Queryable } from './executor.js';
import { canonicalJson, findJsonViolation, isPlainObject, MAX_DOCUMENT_BYTES, sha256Hex, type JsonViolation } from './json.js';
import { newUuid, TS } from './store.js';

export type SchemaRegistry = ReadonlyMap<string, TypeDefinition>;
export type JsonObject = Record<string, unknown>;
export type Variant = 'draft' | 'published';
export const ENVELOPE_KEYS = ['_id', '_type', '_rev', '_createdAt', '_updatedAt'] as const;
const DOCUMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_REFERENCES = 5000;

/** Accepts `x` or `drafts.x`; returns both spellings. Rejects anything outside [A-Za-z0-9_.-] and `versions.` ids. */
export function parseDocumentId(id: unknown): { logical: string; native: string; variant: Variant } {
  if (typeof id !== 'string') return fail('invalid_input');
  const draft = id.startsWith('drafts.');
  const logical = draft ? id.slice(7) : id;
  if (!DOCUMENT_ID.test(logical) || logical.startsWith('drafts.') || logical.startsWith('versions.')) return fail('invalid_input');
  return { logical, native: id, variant: draft ? 'draft' : 'published' };
}
export const isValidLogicalId = (id: string): boolean => { try { return parseDocumentId(id).variant === 'published'; } catch { return false; } };

export function assertRegistry(registry: unknown): asserts registry is SchemaRegistry {
  if (!(registry instanceof Map)) fail('invalid_input');
}

const violationCode = (v: JsonViolation) => v === 'unsafe_key' || v === 'unicode' ? 'unsafe_content' as const
  : v === 'not_json' || v === 'cycle' || v === 'number' ? 'invalid_document' as const : 'limit_exceeded' as const;

export type Prepared = { logicalId: string; type: string; schema: TypeDefinition; body: JsonObject; canonical: string; sha: string; idProvided: boolean };

/** Checks shape/safety/size and splits the envelope off. Does no validation against the schema. */
export function prepareDocument(registry: SchemaRegistry, input: unknown, documentId?: unknown): Prepared {
  if (!isPlainObject(input)) return fail('invalid_document');
  const violation = findJsonViolation(input);
  if (violation) return fail(violationCode(violation));
  const type = input._type;
  const schema = typeof type === 'string' ? registry.get(type) : undefined;
  if (!schema) return fail('unknown_type');
  const fromArg = documentId === undefined ? undefined : parseDocumentId(documentId).logical;
  const fromInput = input._id === undefined ? undefined : parseDocumentId(input._id).logical;
  if (fromArg !== undefined && fromInput !== undefined && fromArg !== fromInput) return fail('invalid_input');
  const logicalId = fromArg ?? fromInput ?? newUuid();
  const body: JsonObject = {};
  for (const key of Object.keys(input)) if (!(ENVELOPE_KEYS as readonly string[]).includes(key)) body[key] = input[key];
  const canonical = canonicalJson(body);
  if (Buffer.byteLength(canonical, 'utf8') > MAX_DOCUMENT_BYTES) return fail('limit_exceeded');
  return { logicalId, type: schema.name, schema, body, canonical, sha: sha256Hex(canonical), idProvided: fromArg !== undefined || fromInput !== undefined };
}

export type Reference = { path: string; target: string; weak: boolean };
/** Every `{_type:'reference', _ref}` object, with a dotted path. Input has passed findJsonViolation. */
export function collectReferences(body: unknown): Reference[] {
  const out: Reference[] = [];
  const walk = (value: unknown, path: string[]) => {
    if (typeof value !== 'object' || value === null) return;
    if (Array.isArray(value)) { value.forEach((item, i) => walk(item, [...path, String(i)])); return; }
    const record = value as JsonObject;
    if (record._type === 'reference' && typeof record._ref === 'string' && record._ref) {
      const joined = path.join('.');
      if (!joined || joined.length > 1024 || record._ref.length > 1024) return fail('limit_exceeded');
      if (out.length >= MAX_REFERENCES) return fail('limit_exceeded');
      out.push({ path: joined, target: record._ref, weak: record._weak === true });
      return;
    }
    for (const key of Object.keys(record)) walk(record[key], [...path, key]);
  };
  walk(body, []);
  return out;
}

/** Index of live (non-archived) documents of the dataset that `refs` point at, plus host-supplied extras (e.g. asset documents). */
export async function buildReferenceIndex(q: Queryable, datasetId: string, targets: Iterable<string>, extra: readonly JsonObject[] = [], assets: readonly JsonObject[] = []): Promise<ReferenceIndex> {
  const ids = [...new Set(targets)];
  const found = ids.length
    ? (await q.query<{ native_id: string; type: string }>('SELECT native_id, type FROM craft.documents WHERE dataset_id = $1 AND logical_id = ANY($2::text[]) AND archived_at IS NULL', [datasetId, ids])).rows
    : [];
  return createReferenceIndex([...found.map(row => ({ _id: row.native_id, _type: row.type })), ...extra], assets);
}

export function assertAssets(assets: unknown): readonly JsonObject[] {
  if (assets === undefined) return [];
  if (!Array.isArray(assets) || assets.length > 10_000) return fail('invalid_input');
  for (const asset of assets) if (!isPlainObject(asset) || typeof asset._id !== 'string' || typeof asset._type !== 'string') return fail('invalid_input');
  return assets as JsonObject[];
}

export type ValidationMode = 'draft' | 'publish';
export function blockingIssues(issues: readonly Issue[], mode: ValidationMode): Issue[] {
  return issues.filter(issue => issue.severity === 'error' && (mode === 'publish' || issue.code !== 'publish_required'));
}
/** Craft's own validator decides. Drafts may omit publishRequired fields; publishing may not. Warnings never block. */
export function validateOrFail(schema: TypeDefinition, doc: JsonObject, index: ReferenceIndex, mode: ValidationMode): void {
  const blocking = blockingIssues(validateDocument(schema, doc, index), mode);
  if (blocking.length) throw new CraftError('validation_failed', { issues: blocking.slice(0, 50).map(issue => ({ path: issue.path, code: issue.code, message: issue.message })) });
}

export type DocRow = {
  id: string; native_id: string; type: string; logical_id: string; variant: Variant; lock_version: number; archived: boolean;
  current_revision_id: string | null; native_rev: string | null; sequence: number | null; schema_version: number | null;
  payload: JsonObject | null; payload_sha256: string | null; actor_id: string | null; created_at: string; updated_at: string | null;
};
export const DOC_COLUMNS = `d.id, d.native_id, d.type, d.logical_id, d.variant, d.lock_version, (d.archived_at IS NOT NULL) AS archived,
  d.current_revision_id, r.native_rev, r.sequence, r.schema_version, r.payload, r.payload_sha256, r.actor_id,
  ${TS('d.created_at')} AS created_at, ${TS('r.created_at')} AS updated_at`;
export const DOC_FROM = `FROM craft.documents d LEFT JOIN craft.revisions r
  ON r.dataset_id = d.dataset_id AND r.document_id = d.id AND r.id = d.current_revision_id`;

export type LogicalRows = { draft?: DocRow; published?: DocRow };
/** Locks both variants of one logical id (draft first), so writers of the same document serialize. */
export async function lockLogical(q: Queryable, datasetId: string, logicalId: string): Promise<LogicalRows> {
  const found = await q.query<DocRow>(`SELECT ${DOC_COLUMNS} ${DOC_FROM} WHERE d.dataset_id = $1 AND d.logical_id = $2 ORDER BY d.variant FOR UPDATE OF d`, [datasetId, logicalId]);
  const rows: LogicalRows = {};
  for (const row of found.rows) rows[row.variant] = row;
  return rows;
}
export const live = (row: DocRow | undefined): DocRow | undefined => row && !row.archived ? row : undefined;
/** The document the editor is looking at: the live draft, else the live published variant. */
export const headOf = (rows: LogicalRows): DocRow | undefined => live(rows.draft) ?? live(rows.published);

export function composeDocument(row: DocRow, asLogical = false): JsonObject {
  return { ...row.payload, _id: asLogical ? row.logical_id : row.native_id, _type: row.type, _rev: row.native_rev, _createdAt: row.created_at, _updatedAt: row.updated_at };
}

export type Expectation = { nativeRev?: string; lockVersion?: number };
export function readExpectation(nativeRev: unknown, lockVersion: unknown): Expectation {
  if (nativeRev !== undefined && (typeof nativeRev !== 'string' || !nativeRev || nativeRev.length > 128)) return fail('invalid_input');
  if (lockVersion !== undefined && (typeof lockVersion !== 'number' || !Number.isSafeInteger(lockVersion) || lockVersion < 0)) return fail('invalid_input');
  return { nativeRev: nativeRev as string | undefined, lockVersion: lockVersion as number | undefined };
}
/** Compare-and-set precondition against the head row. Changing an existing document always needs an expectation. */
export function checkExpectation(head: DocRow | undefined, expected: Expectation): void {
  if (!head) {
    if (expected.nativeRev !== undefined || (expected.lockVersion !== undefined && expected.lockVersion !== 0)) fail('conflict');
    return;
  }
  if (expected.nativeRev === undefined && expected.lockVersion === undefined) fail('precondition_required');
  if (expected.nativeRev !== undefined && expected.nativeRev !== head.native_rev) fail('conflict');
  if (expected.lockVersion !== undefined && expected.lockVersion !== head.lock_version) fail('conflict');
}

export async function insertDocumentRow(q: Queryable, datasetId: string, parsed: { native: string; logical: string; variant: Variant }, type: string): Promise<{ id: string; lock: number }> {
  const made = await q.query<{ id: string }>(
    'INSERT INTO craft.documents (dataset_id, native_id, type, logical_id, variant) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [datasetId, parsed.native, type, parsed.logical, parsed.variant]);
  return { id: made.rows[0].id, lock: 0 };
}

export type NewRevision = { id: string; native_rev: string; sequence: number };
const NEXT_SEQUENCE = '(SELECT coalesce(max(sequence), 0) + 1 FROM craft.revisions WHERE document_id = $2)';
export async function insertRevision(q: Queryable, datasetId: string, documentId: string, actorId: string, schemaVersion: number, canonical: string, sha: string, refs: readonly Reference[]): Promise<NewRevision> {
  const made = await q.query<NewRevision>(
    `INSERT INTO craft.revisions (dataset_id, document_id, sequence, schema_version, payload, payload_sha256, actor_id)
     VALUES ($1, $2, ${NEXT_SEQUENCE}, $3, $4::jsonb, $5, $6) RETURNING id, native_rev, sequence`,
    [datasetId, documentId, schemaVersion, canonical, sha, actorId]);
  const revision = made.rows[0];
  if (refs.length) {
    await q.query(
      `INSERT INTO craft."references" (dataset_id, revision_id, path, target_native_id, weak)
       SELECT $1, $2, p, t, w FROM unnest($3::text[], $4::text[], $5::boolean[]) AS x(p, t, w)`,
      [datasetId, revision.id, refs.map(r => r.path), refs.map(r => r.target), refs.map(r => r.weak)]);
  }
  return revision;
}
/** New revision of `documentId` that copies payload (and its reference rows) from an existing revision of the same dataset. */
export async function copyRevision(q: Queryable, datasetId: string, documentId: string, fromRevisionId: string, actorId: string): Promise<NewRevision> {
  const made = await q.query<NewRevision>(
    `INSERT INTO craft.revisions (dataset_id, document_id, sequence, schema_version, payload, payload_sha256, actor_id)
     SELECT $1, $2, ${NEXT_SEQUENCE}, schema_version, payload, payload_sha256, $4 FROM craft.revisions WHERE id = $3 AND dataset_id = $1
     RETURNING id, native_rev, sequence`, [datasetId, documentId, fromRevisionId, actorId]);
  const revision = made.rows[0] ?? fail('not_found');
  await q.query(
    `INSERT INTO craft."references" (dataset_id, revision_id, path, target_native_id, weak)
     SELECT dataset_id, $2, path, target_native_id, weak FROM craft."references" WHERE revision_id = $1 AND dataset_id = $3`,
    [fromRevisionId, revision.id, datasetId]);
  return revision;
}

/** Moves the current pointer (compare-and-set on lock_version), clears archived_at. Returns the new lock_version. */
export async function pointTo(q: Queryable, datasetId: string, documentId: string, revisionId: string, expectedLock: number): Promise<number> {
  const moved = await q.query<{ lock_version: number }>(
    `UPDATE craft.documents SET current_revision_id = $3, lock_version = lock_version + 1, updated_at = now(), archived_at = NULL
     WHERE dataset_id = $1 AND id = $2 AND lock_version = $4 RETURNING lock_version`, [datasetId, documentId, revisionId, expectedLock]);
  return moved.rows[0]?.lock_version ?? fail('conflict');
}
export async function archive(q: Queryable, datasetId: string, row: DocRow): Promise<number> {
  const done = await q.query<{ lock_version: number }>(
    `UPDATE craft.documents SET archived_at = now(), lock_version = lock_version + 1, updated_at = now()
     WHERE dataset_id = $1 AND id = $2 AND lock_version = $3 AND archived_at IS NULL RETURNING lock_version`, [datasetId, row.id, row.lock_version]);
  return done.rows[0]?.lock_version ?? fail('conflict');
}
