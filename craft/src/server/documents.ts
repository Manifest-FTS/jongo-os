/**
 * Document lifecycle. Semantics (Sanity-like, documented in the README):
 *  - A logical id has up to two rows: `drafts.<id>` (draft) and `<id>` (published). Revisions are append-only.
 *  - saveDraft writes a new draft revision. The "head" a caller edits is the live draft, else the live published row.
 *  - publish writes a NEW published revision from the draft's current payload and soft-archives the draft row.
 *    After publish only the published variant is live, so draft and published are equal by construction.
 *  - saveDraft on a published document un-archives (or creates) the draft; unpublish archives the published row and
 *    restores a draft from the published payload (a live draft is left untouched); discardDraft archives the draft
 *    only while a live published variant exists. Nothing is ever hard-deleted.
 *  - Every change is compare-and-set on the head's native revision and/or lock_version, under row locks, in one
 *    transaction with its idempotency receipt and audit row.
 */
import { requireAccess, type CraftContext } from './auth.js';
import {
  archive, assertAssets, assertRegistry, buildReferenceIndex, checkExpectation, collectReferences, composeDocument, copyRevision, DOC_COLUMNS, DOC_FROM,
  headOf, insertDocumentRow, insertRevision, live, lockLogical, parseDocumentId, pointTo, prepareDocument, readExpectation, validateOrFail,
  type DocRow, type JsonObject, type SchemaRegistry, type Variant
} from './docs-core.js';
import { fail } from './errors.js';
import type { Perspective } from './query/groq.js';
import { toPublicDocument } from './query/privacy.js';
import { inTransaction, resolveDataset, runMutation, TS } from './store.js';

export type DocumentMutationResult = {
  documentId: string; logicalId: string; type: string; variant: Variant;
  nativeRev: string; lockVersion: number; sequence: number; replayed: boolean;
};
type Stored = Omit<DocumentMutationResult, 'replayed'>;

type Common = { dataset: string; registry: SchemaRegistry; mutationKey: string };
type Cas = { expectedNativeRev?: string; expectedLockVersion?: number };

export type SaveDraftInput = Common & Cas & {
  /** Native or logical id of the document; omitted for a new document whose `_id` is absent too (a UUID is generated). */
  documentId?: string;
  /** The document body as the Studio edits it. Envelope fields (_rev, _createdAt, _updatedAt) are ignored. */
  input: unknown;
  /** Asset documents known to the host, so image references can be validated. */
  assets?: readonly JsonObject[];
};

/** Requires 'write'. Validates with Craft's validator (publishRequired is not enforced for drafts). */
export async function saveDraft(ctx: CraftContext, options: SaveDraftInput): Promise<DocumentMutationResult> {
  await requireAccess(ctx, options?.dataset, 'write');
  assertRegistry(options.registry);
  const prepared = prepareDocument(options.registry, options.input, options.documentId);
  const expected = readExpectation(options.expectedNativeRev, options.expectedLockVersion);
  const assets = assertAssets(options.assets);
  const draft = parseDocumentId(`drafts.${prepared.logicalId}`);
  const request = { documentId: prepared.idProvided ? prepared.logicalId : null, body: prepared.body, expectedNativeRev: expected.nativeRev ?? null, expectedLockVersion: expected.lockVersion ?? null };
  return runMutation<Stored>(ctx, {
    dataset: options.dataset, action: 'write', operation: 'saveDraft', key: options.mutationKey, request, authorized: true,
    async work(q, dataset) {
      const rows = await lockLogical(q, dataset.id, prepared.logicalId);
      const existingType = (rows.draft ?? rows.published)?.type;
      if (existingType !== undefined && existingType !== prepared.type) return fail('conflict');
      checkExpectation(headOf(rows), expected);
      const refs = collectReferences(prepared.body);
      const index = await buildReferenceIndex(q, dataset.id, refs.map(r => r.target), [], assets);
      validateOrFail(prepared.schema, { ...prepared.body, _id: prepared.logicalId, _type: prepared.type }, index, 'draft');
      const row = rows.draft ?? { id: (await insertDocumentRow(q, dataset.id, draft, prepared.type)).id, lock_version: 0 };
      const revision = await insertRevision(q, dataset.id, row.id, ctx.actorId, prepared.schema.schemaVersion, prepared.canonical, prepared.sha, refs);
      const lockVersion = await pointTo(q, dataset.id, row.id, revision.id, row.lock_version);
      const result: Stored = { documentId: draft.native, logicalId: prepared.logicalId, type: prepared.type, variant: 'draft', nativeRev: revision.native_rev, lockVersion, sequence: revision.sequence };
      return { result, audit: { action: 'document.save', documentId: row.id, detail: { documentId: draft.native, type: prepared.type, sequence: revision.sequence, sha256: prepared.sha } } };
    }
  });
}
type LifecycleInput = Common & Cas & { documentId: string; assets?: readonly JsonObject[] };
function lifecycle(options: LifecycleInput) {
  assertRegistry(options?.registry);
  const id = parseDocumentId(options.documentId);
  const expected = readExpectation(options.expectedNativeRev, options.expectedLockVersion);
  return { id, expected, request: { documentId: id.logical, expectedNativeRev: expected.nativeRev ?? null, expectedLockVersion: expected.lockVersion ?? null } };
}
const needPayload = (row: DocRow) => (row.payload && row.current_revision_id && row.schema_version ? row : fail('not_found'));

/** Requires 'publish'. Publishes the live draft; fails with validation_failed unless it is fully valid (publishRequired included). */
export async function publishDocument(ctx: CraftContext, options: LifecycleInput): Promise<DocumentMutationResult> {
  await requireAccess(ctx, options?.dataset, 'publish');
  const { id, expected, request } = lifecycle(options);
  const assets = assertAssets(options.assets);
  return runMutation<Stored>(ctx, {
    dataset: options.dataset, action: 'publish', operation: 'publish', key: options.mutationKey, request, authorized: true,
    async work(q, dataset) {
      const rows = await lockLogical(q, dataset.id, id.logical);
      const draft = live(rows.draft) ?? fail('not_found');
      checkExpectation(draft, expected);
      const source = needPayload(draft);
      const schema = options.registry.get(source.type) ?? fail('unknown_type');
      const refs = collectReferences(source.payload);
      const index = await buildReferenceIndex(q, dataset.id, refs.map(r => r.target), [], assets);
      validateOrFail(schema, { ...source.payload, _id: id.logical, _type: source.type }, index, 'publish');
      const target = rows.published ?? { id: (await insertDocumentRow(q, dataset.id, { native: id.logical, logical: id.logical, variant: 'published' }, source.type)).id, lock_version: 0 };
      const revision = await copyRevision(q, dataset.id, target.id, source.current_revision_id!, ctx.actorId);
      const lockVersion = await pointTo(q, dataset.id, target.id, revision.id, target.lock_version);
      await archive(q, dataset.id, draft);
      const result: Stored = { documentId: id.logical, logicalId: id.logical, type: source.type, variant: 'published', nativeRev: revision.native_rev, lockVersion, sequence: revision.sequence };
      return { result, audit: { action: 'document.publish', documentId: target.id, detail: { documentId: id.logical, type: source.type, sequence: revision.sequence, fromDraftSequence: source.sequence } } };
    }
  });
}

/** Requires 'publish'. Archives the published variant and restores a draft (existing live draft edits are kept). */
export async function unpublishDocument(ctx: CraftContext, options: LifecycleInput): Promise<DocumentMutationResult> {
  await requireAccess(ctx, options?.dataset, 'publish');
  const { id, expected, request } = lifecycle(options);
  return runMutation<Stored>(ctx, {
    dataset: options.dataset, action: 'publish', operation: 'unpublish', key: options.mutationKey, request, authorized: true,
    async work(q, dataset) {
      const rows = await lockLogical(q, dataset.id, id.logical);
      const published = live(rows.published) ?? fail('not_found');
      checkExpectation(published, expected);
      const source = needPayload(published);
      let draft = rows.draft;
      let result: Stored;
      if (live(draft)) {
        const kept = draft!;
        result = { documentId: kept.native_id, logicalId: id.logical, type: kept.type, variant: 'draft', nativeRev: kept.native_rev!, lockVersion: kept.lock_version, sequence: kept.sequence! };
      } else {
        draft ??= { id: (await insertDocumentRow(q, dataset.id, { native: `drafts.${id.logical}`, logical: id.logical, variant: 'draft' }, source.type)).id, lock_version: 0 } as DocRow;
        const revision = await copyRevision(q, dataset.id, draft.id, source.current_revision_id!, ctx.actorId);
        const lockVersion = await pointTo(q, dataset.id, draft.id, revision.id, draft.lock_version);
        result = { documentId: `drafts.${id.logical}`, logicalId: id.logical, type: source.type, variant: 'draft', nativeRev: revision.native_rev, lockVersion, sequence: revision.sequence };
      }
      await archive(q, dataset.id, published);
      return { result, audit: { action: 'document.unpublish', documentId: published.id, detail: { documentId: id.logical, type: source.type } } };
    }
  });
}

/** Requires 'write'. Archives the live draft, leaving the published variant; refused when nothing is published. */
export async function discardDraft(ctx: CraftContext, options: LifecycleInput): Promise<DocumentMutationResult> {
  await requireAccess(ctx, options?.dataset, 'write');
  const { id, expected, request } = lifecycle(options);
  return runMutation<Stored>(ctx, {
    dataset: options.dataset, action: 'write', operation: 'discardDraft', key: options.mutationKey, request, authorized: true,
    async work(q, dataset) {
      const rows = await lockLogical(q, dataset.id, id.logical);
      const draft = live(rows.draft) ?? fail('not_found');
      const published = live(rows.published);
      if (!published) return fail('conflict');
      checkExpectation(draft, expected);
      await archive(q, dataset.id, draft);
      const result: Stored = { documentId: id.logical, logicalId: id.logical, type: published.type, variant: 'published', nativeRev: published.native_rev!, lockVersion: published.lock_version, sequence: published.sequence! };
      return { result, audit: { action: 'document.discard', documentId: draft.id, detail: { documentId: id.logical, type: draft.type, sequence: draft.sequence } } };
    }
  });
}

export type DeleteDocumentInput = { dataset: string; documentId: string; mutationKey: string } & Cas;
export type DeleteDocumentResult = { logicalId: string; type: string; variants: Variant[]; replayed: boolean };

/**
 * Requires BOTH 'write' and 'publish' (it can remove published content). Soft-archives the live draft and the live published row of the
 * logical id in one transaction: revisions, references, receipts and audit rows are never touched, so the log stays append-only. Afterwards
 * the id is absent from get/list/query/export (all of them read only non-archived rows). The same id may later be created again with
 * saveDraft (no expectation): that un-archives the old row and appends a revision, so the history continues but nothing of the old content is live.
 * Compare-and-set is on the head (draft, else published), like publish. Refused with 'referenced' while another LIVE document holds a
 * strong reference to this id (weak references and self-references do not block), the same rule that makes a missing target fail validation.
 */
export async function deleteDocument(ctx: CraftContext, options: DeleteDocumentInput): Promise<DeleteDocumentResult> {
  await requireAccess(ctx, options?.dataset, 'write', 'publish');
  const id = parseDocumentId(options.documentId);
  const expected = readExpectation(options.expectedNativeRev, options.expectedLockVersion);
  const request = { documentId: id.logical, expectedNativeRev: expected.nativeRev ?? null, expectedLockVersion: expected.lockVersion ?? null };
  return runMutation<Omit<DeleteDocumentResult, 'replayed'>>(ctx, {
    dataset: options.dataset, action: 'publish', operation: 'delete', key: options.mutationKey, request, authorized: true,
    async work(q, dataset) {
      const rows = await lockLogical(q, dataset.id, id.logical);
      const head = headOf(rows) ?? fail('not_found');
      checkExpectation(head, expected);
      const referrers = await q.query<{ n: string }>(
        `SELECT count(DISTINCT d.logical_id) AS n FROM craft."references" rf
         JOIN craft.documents d ON d.dataset_id = rf.dataset_id AND d.current_revision_id = rf.revision_id AND d.archived_at IS NULL
         WHERE rf.dataset_id = $1 AND rf.target_native_id = $2 AND NOT rf.weak AND d.logical_id <> $2`, [dataset.id, id.logical]);
      if (Number(referrers.rows[0].n) > 0) return fail('referenced');
      const variants: Variant[] = [];
      for (const row of [live(rows.draft), live(rows.published)]) {
        if (!row) continue;
        await archive(q, dataset.id, row);
        variants.push(row.variant);
      }
      const result = { logicalId: id.logical, type: head.type, variants };
      return { result, audit: { action: 'document.delete', documentId: head.id, detail: { documentId: id.logical, type: head.type, variants } } };
    }
  });
}

const READ_VARIANTS: Record<Perspective, Variant[]> = { published: ['published'], previewDrafts: ['draft', 'published'], raw: ['draft', 'published'] };
function readActions(perspective: unknown, consumer: unknown) {
  if (perspective !== 'published' && perspective !== 'previewDrafts' && perspective !== 'raw') return fail('invalid_perspective');
  if (consumer !== 'public' && consumer !== 'editor') return fail('invalid_options');
  return perspective === 'published' && consumer === 'public' ? ['read' as const] : ['read-drafts' as const, ...(perspective === 'published' ? ['read' as const] : [])];
}

export type GetDocumentInput = {
  dataset: string; documentId: string; registry: SchemaRegistry;
  /** Default 'published'. 'raw' addresses the exact native id, including `drafts.`. */
  perspective?: Perspective;
  /** Default 'public' (private and undeclared fields removed). 'editor' keeps them and needs 'read-drafts'. */
  consumer?: 'public' | 'editor';
};
export type GetDocumentResult = { document: JsonObject; variant: Variant; nativeRev: string; lockVersion: number; sequence: number; schemaVersion: number; /** When and by which actor id this revision was written. */ updatedAt: string; actorId: string };

/** 'published' perspective needs 'read'; 'previewDrafts'/'raw' (and consumer 'editor') need 'read-drafts'. Returns null when absent. */
export async function getDocument(ctx: CraftContext, options: GetDocumentInput): Promise<GetDocumentResult | null> {
  const perspective = options?.perspective ?? 'published';
  const consumer = options?.consumer ?? 'public';
  await requireAccess(ctx, options?.dataset, ...readActions(perspective, consumer));
  const id = parseDocumentId(options.documentId);
  assertRegistry(options.registry);
  return inTransaction(ctx, async q => {
    const dataset = await resolveDataset(q, options.dataset);
    const found = perspective === 'raw'
      ? await q.query<DocRow>(`SELECT ${DOC_COLUMNS} ${DOC_FROM} WHERE d.dataset_id = $1 AND d.native_id = $2 AND d.archived_at IS NULL`, [dataset.id, id.native])
      : await q.query<DocRow>(`SELECT ${DOC_COLUMNS} ${DOC_FROM} WHERE d.dataset_id = $1 AND d.logical_id = $2 AND d.archived_at IS NULL AND d.variant = ANY($3::text[]) ORDER BY d.variant LIMIT 1`,
        [dataset.id, id.logical, READ_VARIANTS[perspective]]);
    const row = found.rows[0];
    if (!row || !row.payload) return null;
    const full = composeDocument(row, perspective !== 'raw');
    const document = consumer === 'public' ? toPublicDocument(full, options.registry) : full;
    return document ? { document, variant: row.variant, nativeRev: row.native_rev!, lockVersion: row.lock_version, sequence: row.sequence!, schemaVersion: row.schema_version!, updatedAt: row.updated_at!, actorId: row.actor_id! } : null;
  }, { snapshot: true });
}

export type ListDocumentsInput = { dataset: string; perspective?: Perspective; type?: string; limit?: number; cursor?: string };
export type DocumentSummary = { id: string; nativeId: string; type: string; variant: Variant; nativeRev: string; lockVersion: number; updatedAt: string };
export type ListDocumentsResult = { items: DocumentSummary[]; nextCursor: string | null };
const MAX_PAGE = 200;

/** Metadata only, never payloads. Keyset pagination (stable under concurrent writes). Same authorization as getDocument with consumer 'public'. */
export async function listDocuments(ctx: CraftContext, options: ListDocumentsInput): Promise<ListDocumentsResult> {
  const perspective = options?.perspective ?? 'published';
  await requireAccess(ctx, options?.dataset, ...readActions(perspective, 'public'));
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) return fail('invalid_input');
  if (options.type !== undefined && (typeof options.type !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(options.type))) return fail('invalid_input');
  let after: string | null = null;
  if (options.cursor !== undefined) {
    if (typeof options.cursor !== 'string' || options.cursor.length > 400) return fail('invalid_input');
    after = Buffer.from(options.cursor, 'base64url').toString('utf8');
    if (!after || after.length > 300 || Buffer.from(after, 'utf8').toString('base64url') !== options.cursor) return fail('invalid_input');
  }
  return inTransaction(ctx, async q => {
    const dataset = await resolveDataset(q, options.dataset);
    const raw = perspective === 'raw';
    const key = raw ? 'd.native_id' : 'd.logical_id';
    const found = await q.query<{ id: string; native_id: string; type: string; variant: Variant; native_rev: string; lock_version: number; updated_at: string }>(
      `SELECT DISTINCT ON (${key}) ${key} AS id, d.native_id, d.type, d.variant, r.native_rev, d.lock_version, ${TS('r.created_at')} AS updated_at
       FROM craft.documents d JOIN craft.revisions r ON r.dataset_id = d.dataset_id AND r.document_id = d.id AND r.id = d.current_revision_id
       WHERE d.dataset_id = $1 AND d.archived_at IS NULL AND d.variant = ANY($2::text[]) AND ($3::text IS NULL OR d.type = $3) AND ($4::text IS NULL OR ${key} > $4)
       ORDER BY ${key}, d.variant LIMIT $5`,
      [dataset.id, READ_VARIANTS[perspective], options.type ?? null, after, limit + 1]);
    const items = found.rows.slice(0, limit).map(row => ({ id: row.id, nativeId: row.native_id, type: row.type, variant: row.variant, nativeRev: row.native_rev, lockVersion: row.lock_version, updatedAt: row.updated_at }));
    const nextCursor = found.rows.length > limit ? Buffer.from(items[items.length - 1].id, 'utf8').toString('base64url') : null;
    return { items, nextCursor };
  }, { snapshot: true });
}

export type DocumentHistoryInput = { dataset: string; documentId: string; limit?: number };
export type DocumentHistoryEntry = { at: string; /** 'save' | 'publish' | 'unpublish' | 'discard' | 'delete' */ action: string; actorId: string };

/** Requires 'read-drafts'. Newest first, from the append-only audit trail (so it survives delete and re-create). Metadata only: no content, no hashes. */
export async function getDocumentHistory(ctx: CraftContext, options: DocumentHistoryInput): Promise<{ entries: DocumentHistoryEntry[] }> {
  await requireAccess(ctx, options?.dataset, 'read-drafts');
  const id = parseDocumentId(options.documentId);
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) return fail('invalid_input');
  return inTransaction(ctx, async q => {
    const dataset = await resolveDataset(q, options.dataset);
    const found = await q.query<{ at: string; action: string; actor_id: string }>(
      `SELECT ${TS('a.at')} AS at, a.action, a.actor_id FROM craft.audit_log a
       WHERE a.dataset_id = $1 AND a.action LIKE 'document.%'
         AND a.document_id IN (SELECT id FROM craft.documents WHERE dataset_id = $1 AND logical_id = $2)
       ORDER BY a.at DESC, a.id DESC LIMIT $3`, [dataset.id, id.logical, limit]);
    return { entries: found.rows.map(row => ({ at: row.at, action: row.action.slice('document.'.length), actorId: row.actor_id })) };
  }, { snapshot: true });
}
