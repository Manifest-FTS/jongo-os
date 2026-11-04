/**
 * GROQ evaluation over an in-memory document set with `groq-js`. Ported from apps/web/src/lib/cms/query/groq.ts
 * (known duplication, to be deduplicated later). No DB, network, env or filesystem access.
 *
 * Time budget caveat: evaluation runs in-process and cannot be cancelled. The budget is enforced by racing a timer
 * and a cooperative check inside `->`; a query that never yields to the event loop can overrun it. Do not expose
 * this to untrusted anonymous callers without moving evaluation into a killable worker.
 *
 * groq-js (^2) needs Node >= 22.12 and is loaded lazily, only when a query runs.
 */
import type { TypeDefinition } from '../../schema.js';
import { fail } from '../errors.js';
import { toPublicDocument } from './privacy.js';

export type Perspective = 'published' | 'previewDrafts' | 'raw';
export type Consumer = 'public' | 'editor';
export type QueryLimits = { maxQueryLength: number; maxDocuments: number; maxParamsBytes: number; maxResultBytes: number; timeoutMs: number };
export const QUERY_DEFAULT_LIMITS: Readonly<QueryLimits> = Object.freeze({
  maxQueryLength: 10_000, maxDocuments: 10_000, maxParamsBytes: 64 * 1024, maxResultBytes: 5 * 1024 * 1024, timeoutMs: 5_000
});
/** Callers may lower limits or raise them only up to these ceilings. */
const CEILINGS: Readonly<QueryLimits> = Object.freeze({
  maxQueryLength: 100_000, maxDocuments: 100_000, maxParamsBytes: 1024 * 1024, maxResultBytes: 32 * 1024 * 1024, timeoutMs: 30_000
});

export type QueryDocument = Record<string, unknown> & { _id: string; _type: string };
export type RunGroqInput = {
  documents: readonly QueryDocument[];
  query: string;
  params?: Record<string, unknown>;
  /** Default 'published'. */
  perspective?: Perspective;
  /** Default 'public': private and undeclared fields are removed before evaluation. */
  consumer?: Consumer;
  limits?: Partial<QueryLimits>;
  registry: ReadonlyMap<string, TypeDefinition>;
};
export type RunGroqResult = { result: unknown; ms: number; documentCount: number };

export function resolveLimits(limits: Partial<QueryLimits> | undefined): QueryLimits {
  const resolved = { ...QUERY_DEFAULT_LIMITS };
  if (limits === undefined) return resolved;
  if (typeof limits !== 'object' || limits === null) return fail('invalid_options');
  for (const key of Object.keys(CEILINGS) as (keyof QueryLimits)[]) {
    const value = limits[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 1 || value > CEILINGS[key]) return fail('invalid_options');
    resolved[key] = value;
  }
  return resolved;
}

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_PARAM_DEPTH = 16;
const MAX_PARAM_NODES = 10_000;

function cloneParam(value: unknown, depth: number, budget: { nodes: number }): unknown {
  if (++budget.nodes > MAX_PARAM_NODES || depth > MAX_PARAM_DEPTH) return fail('invalid_params');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fail('invalid_params');
  if (Array.isArray(value)) return value.map(item => cloneParam(item, depth + 1, budget));
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if ((proto !== Object.prototype && proto !== null) || Object.getOwnPropertySymbols(value).length) return fail('invalid_params');
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (key === '__proto__' || !descriptor || descriptor.get || descriptor.set) return fail('invalid_params');
      out[key] = cloneParam(descriptor.value, depth + 1, budget);
    }
    return out;
  }
  return fail('invalid_params');
}

/** Validates and detaches query and params before any document work or DB access. */
export function validateQueryInput(input: { query: unknown; params?: unknown; limits?: Partial<QueryLimits> }): { query: string; params: Record<string, unknown>; limits: QueryLimits } {
  const limits = resolveLimits(input.limits);
  if (typeof input.query !== 'string' || input.query.trim().length === 0) return fail('invalid_query');
  if (input.query.length > limits.maxQueryLength) return fail('query_too_long');
  const raw = input.params ?? {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('invalid_params');
  const params = cloneParam(raw, 0, { nodes: 0 }) as Record<string, unknown>;
  for (const key of Object.keys(params)) if (!PARAM_NAME.test(key)) return fail('invalid_params');
  if (Buffer.byteLength(JSON.stringify(params), 'utf8') > limits.maxParamsBytes) return fail('params_too_large');
  return { query: input.query, params, limits };
}

const DRAFT = 'drafts.';
const isDraftId = (id: string) => id.startsWith(DRAFT);
const isVersionId = (id: string) => id.startsWith('versions.');

function validateDocuments(documents: unknown, limits: QueryLimits): QueryDocument[] {
  if (!Array.isArray(documents)) return fail('invalid_documents');
  if (documents.length > limits.maxDocuments) return fail('too_many_documents');
  const seen = new Set<string>();
  for (const doc of documents) {
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return fail('invalid_documents');
    const { _id, _type } = doc as Record<string, unknown>;
    if (typeof _id !== 'string' || !_id.length || _id === DRAFT || typeof _type !== 'string' || !_type.length || seen.has(_id)) return fail('invalid_documents');
    seen.add(_id);
  }
  return documents as QueryDocument[];
}

/** Sanity perspective semantics over a flat document list. A draft replaces its published sibling entirely. */
export function applyPerspective(documents: readonly QueryDocument[], perspective: Perspective): QueryDocument[] {
  if (perspective === 'raw') return [...documents];
  if (perspective === 'published') return documents.filter(d => !isDraftId(d._id) && !isVersionId(d._id));
  const merged = new Map<string, QueryDocument>();
  for (const doc of documents) if (!isVersionId(doc._id) && !isDraftId(doc._id) && !merged.has(doc._id)) merged.set(doc._id, doc);
  for (const doc of documents) {
    if (!isDraftId(doc._id)) continue;
    const logical = doc._id.slice(DRAFT.length);
    merged.set(logical, { ...doc, _id: logical });
  }
  return [...merged.values()];
}

class Deadline extends Error {}
type Groq = typeof import('groq-js');

export async function runGroq(input: RunGroqInput): Promise<RunGroqResult> {
  const started = performance.now();
  const { query, params, limits } = validateQueryInput(input);
  const perspective = input.perspective ?? 'published';
  if (perspective !== 'published' && perspective !== 'previewDrafts' && perspective !== 'raw') return fail('invalid_perspective');
  const consumer = input.consumer ?? 'public';
  if (consumer !== 'public' && consumer !== 'editor') return fail('invalid_options');
  if (!(input.registry instanceof Map)) return fail('invalid_options');

  const visible = applyPerspective(validateDocuments(input.documents, limits), perspective);
  let documents: QueryDocument[] = visible;
  if (consumer === 'public') {
    documents = [];
    for (const doc of visible) {
      const safe = toPublicDocument(doc, input.registry);
      if (safe) documents.push(safe as QueryDocument);
    }
  }

  let groq: Groq;
  try { groq = await import('groq-js'); } catch { return fail('dependency_missing'); }

  let tree;
  try { tree = groq.parse(query, { params }); } catch (error) {
    // Parse-phase failures derive from the query text alone, never from documents.
    const e = error as { message?: unknown; position?: unknown; line?: unknown; column?: unknown };
    const message = typeof e?.message === 'string' ? e.message.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 200) : undefined;
    return fail('invalid_query', { message, ...(typeof e?.position === 'number' ? { position: e.position, line: e.line as number, column: e.column as number } : {}) });
  }

  // Dereference resolves only inside the perspective- and privacy-filtered set.
  const byId = new Map<string, QueryDocument>(documents.map(d => [d._id, d]));
  const deadline = started + limits.timeoutMs;
  const dereference = ({ _ref }: { _ref: string }) => {
    if (performance.now() > deadline) throw new Deadline();
    return byId.get(_ref) ?? null;
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Deadline()), limits.timeoutMs); });
  const run = (async () => {
    const value = await groq.evaluate(tree, { dataset: documents, params, dereference, identity: '' });
    return value.get();
  })();
  run.catch(() => {});

  let raw: unknown;
  try { raw = await Promise.race([run, timeout]); } catch (error) {
    // groq-js/runtime errors can embed document values: never forward them.
    return error instanceof Deadline ? fail('timeout') : fail('evaluation_failed');
  } finally { clearTimeout(timer); }
  if (performance.now() - started > limits.timeoutMs) return fail('timeout');

  let encoded: string | undefined;
  try { encoded = JSON.stringify(raw ?? null); } catch { return fail('evaluation_failed'); }
  if (encoded === undefined) encoded = 'null';
  if (Buffer.byteLength(encoded, 'utf8') > limits.maxResultBytes) return fail('result_too_large');
  return { result: JSON.parse(encoded), ms: Math.round((performance.now() - started) * 100) / 100, documentCount: documents.length };
}
