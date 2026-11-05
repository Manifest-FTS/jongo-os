import { requireAccess, type CraftAction, type CraftContext } from './auth.js';
import { assertRegistry, type SchemaRegistry } from './docs-core.js';
import { fail } from './errors.js';
import { resolveNdjsonLimits, serializeNdjson, type NdjsonLimits, type NdjsonManifest } from './ndjson.js';
import { resolveLimits, runGroq, validateQueryInput, type Consumer, type Perspective, type QueryLimits } from './query/groq.js';
import { loadDatasetDocuments } from './snapshot.js';
import { audit, inTransaction, resolveDataset } from './store.js';

const isPerspective = (p: unknown): p is Perspective => p === 'published' || p === 'previewDrafts' || p === 'raw';

export type QueryDatasetInput = {
  dataset: string; registry: SchemaRegistry; query: string; params?: Record<string, unknown>;
  /** Default 'published'. */
  perspective?: Perspective;
  /** Default 'public': private and undeclared fields never reach evaluation. */
  consumer?: Consumer;
  limits?: Partial<QueryLimits>;
};

/**
 * Authorization: 'published' perspective needs 'read'; 'previewDrafts'/'raw' need 'read-drafts'; consumer 'editor'
 * (private fields visible) also needs 'read-drafts'. The whole dataset is loaded into memory per call and refused with
 * dataset_too_large when over `limits.maxDocuments` or 64 MiB of payload. Queries are not audited (volume).
 */
export async function queryDataset(ctx: CraftContext, options: QueryDatasetInput): Promise<{ result: unknown; ms: number; documentCount: number }> {
  const perspective = options?.perspective ?? 'published';
  const consumer = options?.consumer ?? 'public';
  if (!isPerspective(perspective)) return fail('invalid_perspective');
  if (consumer !== 'public' && consumer !== 'editor') return fail('invalid_options');
  const actions: CraftAction[] = perspective !== 'published' ? ['read-drafts'] : consumer === 'editor' ? ['read-drafts', 'read'] : ['read'];
  await requireAccess(ctx, options.dataset, ...actions);
  assertRegistry(options.registry);
  const { limits } = validateQueryInput(options);
  const documents = await inTransaction(ctx, async q => loadDatasetDocuments(q, (await resolveDataset(q, options.dataset)).id, { maxDocuments: limits.maxDocuments }), { snapshot: true });
  return runGroq({ documents, query: options.query, params: options.params, perspective, consumer, limits: resolveLimits(options.limits), registry: options.registry });
}

export type ExportNdjsonInput = {
  dataset: string; registry: SchemaRegistry;
  /** Default 'published'. 'raw' keeps drafts and `drafts.` ids (backup shape). */
  perspective?: Perspective;
  /** Default false. Needs 'export-private'. */
  includePrivate?: boolean;
  /** Test seam: fixes the manifest timestamp. Default: now. */
  exportedAt?: string;
  limits?: Partial<NdjsonLimits>;
};

/** Needs 'export'; includePrivate also 'export-private'; perspectives other than 'published' also 'read-drafts'. Writes one audit row. */
export async function exportNdjson(ctx: CraftContext, options: ExportNdjsonInput): Promise<{ bytes: Buffer; manifest: NdjsonManifest }> {
  const perspective = options?.perspective ?? 'published';
  if (!isPerspective(perspective)) return fail('invalid_perspective');
  if (options.includePrivate !== undefined && typeof options.includePrivate !== 'boolean') return fail('invalid_options');
  const includePrivate = options.includePrivate === true;
  const actions: CraftAction[] = ['export'];
  if (includePrivate) actions.push('export-private');
  if (perspective !== 'published') actions.push('read-drafts');
  await requireAccess(ctx, options.dataset, ...actions);
  assertRegistry(options.registry);
  const limits = resolveNdjsonLimits(options.limits);
  const loaded = await inTransaction(ctx, async q => {
    const dataset = await resolveDataset(q, options.dataset);
    return { id: dataset.id, documents: await loadDatasetDocuments(q, dataset.id, { maxDocuments: limits.maxDocuments }) };
  }, { snapshot: true });
  const out = serializeNdjson(loaded.documents, { exportedAt: options.exportedAt ?? new Date().toISOString(), perspective, includePrivate, limits: options.limits, registry: options.registry });
  await inTransaction(ctx, q => audit(q, ctx, {
    action: 'export.ndjson', datasetId: loaded.id,
    detail: { perspective, includePrivate, documentCount: out.manifest.documentCount, byteLength: out.manifest.byteLength, sha256: out.manifest.sha256 }
  }));
  return out;
}
