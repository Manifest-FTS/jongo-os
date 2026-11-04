/**
 * Sanity-style `data.ndjson` for Craft documents. Ported from apps/web/src/lib/cms/export/ndjson.ts and
 * import/reader.ts (known duplication, to be deduplicated later). Pure: no DB, network, env or filesystem.
 *
 * Format ("craft-ndjson-v1"): UTF-8, no BOM, LF line endings, one JSON object per line, each a full document
 * (`_id,_type,_rev,_createdAt,_updatedAt` + payload), a trailing newline after every line. Documents are ordered by
 * logical id, then variant (published, draft), then `_id`. Object keys are sorted at every depth (array order is
 * preserved), so equal input gives equal bytes. U+0085, U+2028 and U+2029 are written as `\u` escapes.
 *
 * Secrets: properties whose NAME looks secret (isSecretKey) are dropped at any depth, even with `includePrivate`.
 * This is a key-name heuristic; it cannot find a secret stored as a value under an innocent key.
 */
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import type { TypeDefinition } from '../schema.js';
import { CraftError, fail, type CraftErrorCode } from './errors.js';
import { findJsonViolation, JSON_LIMITS, MALFORMED_UTF16, UNSAFE_KEYS } from './json.js';
import { applyPerspective, type Perspective, type QueryDocument } from './query/groq.js';
import { toPublicDocument } from './query/privacy.js';
import { isSecretKey } from './redact.js';

export const NDJSON_FORMAT = 'craft-ndjson-v1' as const;
export const NDJSON_ORDERING = 'logicalId,variant,_id' as const;

export type NdjsonLimits = { maxDocuments: number; maxLineBytes: number; maxTotalBytes: number };
export const NDJSON_DEFAULT_LIMITS: Readonly<NdjsonLimits> = Object.freeze({ maxDocuments: 10_000, maxLineBytes: 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024 });
export const NDJSON_LIMIT_CEILINGS: Readonly<NdjsonLimits> = Object.freeze({ maxDocuments: 100_000, maxLineBytes: 8 * 1024 * 1024, maxTotalBytes: 128 * 1024 * 1024 });

export function resolveNdjsonLimits(limits: Partial<NdjsonLimits> | undefined): NdjsonLimits {
  const resolved = { ...NDJSON_DEFAULT_LIMITS };
  if (limits === undefined) return resolved;
  if (typeof limits !== 'object' || limits === null) return fail('invalid_options');
  for (const key of Object.keys(NDJSON_LIMIT_CEILINGS) as (keyof NdjsonLimits)[]) {
    const value = limits[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 1 || value > NDJSON_LIMIT_CEILINGS[key]) return fail('invalid_options');
    resolved[key] = value;
  }
  return resolved;
}

export const isTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19);
};

type Variant = 'published' | 'draft';
const variantOf = (id: string): Variant => id.startsWith('drafts.') ? 'draft' : 'published';
const logicalOf = (id: string) => id.startsWith('drafts.') ? id.slice(7) : id;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const byExportOrder = (a: QueryDocument, b: QueryDocument) =>
  compare(logicalOf(a._id), logicalOf(b._id)) || (variantOf(a._id) === variantOf(b._id) ? 0 : variantOf(a._id) === 'published' ? -1 : 1) || compare(a._id, b._id);

export type NdjsonSerializeOptions = {
  /** Injected (never read from the clock) so the manifest is deterministic. UTC ISO timestamp. */
  exportedAt: string;
  /** Default 'published'. 'raw' is the faithful backup (keeps `drafts.` ids); 'previewDrafts' is a merged view. */
  perspective?: Perspective;
  /** Default false. Must be exactly `true` to keep private and undeclared fields and unregistered types. Secret-named keys go regardless. */
  includePrivate?: boolean;
  limits?: Partial<NdjsonLimits>;
  registry: ReadonlyMap<string, TypeDefinition>;
};

export type NdjsonManifest = {
  format: typeof NDJSON_FORMAT; exportedAt: string; perspective: Perspective; includePrivate: boolean; ordering: typeof NDJSON_ORDERING;
  documentCount: number; byteLength: number;
  /** SHA-256 (hex) of the exact bytes. Integrity against corruption, not authenticity: the manifest is unsigned. */
  sha256: string;
  counts: { byType: Record<string, number>; byVariant: Record<Variant, number> };
  /** Documents left out because their type is unregistered and privacy cannot be decided (count only). */
  omitted: { unregisteredType: number };
  /** Number of properties dropped because their name looked secret (never their names or values). */
  redactedSecretKeyCount: number;
  schema: { envelope: 'sanity-document-v1'; craftSchemaVersions: Record<string, number>; unregisteredTypes: string[] };
  limits: NdjsonLimits;
};

const LINE_BREAKERS = /[\u0085\u2028\u2029]/g;
const escapeUnit = (c: string) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
function encodeString(value: string, id: string): string {
  if (value.length > JSON_LIMITS.string || MALFORMED_UTF16.test(value)) return fail('invalid_document', { documentId: id });
  return JSON.stringify(value).replace(LINE_BREAKERS, escapeUnit);
}

function encodeDocument(doc: Record<string, unknown>, id: string, maxLineBytes: number): { line: string; redacted: number } {
  const parts: string[] = [];
  let chars = 0, redacted = 0;
  const emit = (text: string) => {
    chars += text.length;
    if (chars > maxLineBytes) fail('line_too_large', { documentId: id });
    parts.push(text);
  };
  const walk = (value: unknown): void => {
    if (value === null) return emit('null');
    switch (typeof value) {
      case 'boolean': return emit(value ? 'true' : 'false');
      case 'number':
        if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) return fail('invalid_document', { documentId: id });
        return emit(JSON.stringify(value));
      case 'string': return emit(encodeString(value, id));
      case 'object': {
        if (Array.isArray(value)) { emit('['); value.forEach((item, i) => { if (i) emit(','); walk(item); }); return emit(']'); }
        emit('{');
        let first = true;
        for (const key of Object.keys(value as object).sort()) {
          if (isSecretKey(key)) { redacted++; continue; }
          if (!first) emit(',');
          first = false;
          emit(encodeString(key, id)); emit(':');
          walk((value as Record<string, unknown>)[key]);
        }
        return emit('}');
      }
      default: return fail('invalid_document', { documentId: id });
    }
  };
  walk(doc);
  return { line: parts.join(''), redacted };
}

/** Whole-file export. All or nothing; throws typed errors that carry at most a (truncated) document id. */
export function serializeNdjson(documents: readonly QueryDocument[], options: NdjsonSerializeOptions): { bytes: Buffer; manifest: NdjsonManifest } {
  if (typeof options !== 'object' || options === null || !isTimestamp(options.exportedAt)) return fail('invalid_options');
  const perspective = options.perspective ?? 'published';
  if (perspective !== 'published' && perspective !== 'previewDrafts' && perspective !== 'raw') return fail('invalid_perspective');
  if (options.includePrivate !== undefined && typeof options.includePrivate !== 'boolean') return fail('invalid_options');
  if (!(options.registry instanceof Map)) return fail('invalid_options');
  const includePrivate = options.includePrivate === true;
  const limits = resolveNdjsonLimits(options.limits);
  if (!Array.isArray(documents)) return fail('invalid_document');
  if (documents.length > limits.maxDocuments) return fail('too_many_documents');
  const seen = new Set<string>();
  for (const doc of documents) {
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return fail('invalid_document');
    const { _id, _type, _rev, _createdAt, _updatedAt } = doc as Record<string, unknown>;
    const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1024;
    if (!text(_id) || _id === 'drafts.' || !text(_type) || !text(_rev) || !isTimestamp(_createdAt) || !isTimestamp(_updatedAt)) return fail('invalid_document', { documentId: typeof _id === 'string' ? _id.slice(0, 200) : undefined });
    if (seen.has(_id)) return fail('duplicate_id', { documentId: _id.slice(0, 200) });
    seen.add(_id);
  }

  const ordered = applyPerspective(documents, perspective).sort(byExportOrder);
  const hash = createHash('sha256');
  const chunks: Buffer[] = [];
  const byType = new Map<string, number>();
  const byVariant: Record<Variant, number> = { published: 0, draft: 0 };
  let bytes = 0, redacted = 0, unregistered = 0;
  for (const doc of ordered) {
    const source = includePrivate ? doc : toPublicDocument(doc, options.registry);
    if (!source) { unregistered++; continue; }
    if (findJsonViolation(source)) return fail('invalid_document', { documentId: doc._id.slice(0, 200) });
    const encoded = encodeDocument(source, doc._id.slice(0, 200), limits.maxLineBytes);
    const chunk = Buffer.from(`${encoded.line}\n`, 'utf8');
    if (chunk.length - 1 > limits.maxLineBytes) return fail('line_too_large', { documentId: doc._id.slice(0, 200) });
    bytes += chunk.length;
    if (bytes > limits.maxTotalBytes) return fail('output_too_large');
    hash.update(chunk); chunks.push(chunk);
    redacted += encoded.redacted;
    byType.set(doc._type, (byType.get(doc._type) ?? 0) + 1);
    byVariant[variantOf(doc._id)]++;
  }
  const types = [...byType.keys()].sort();
  const manifest: NdjsonManifest = {
    format: NDJSON_FORMAT, exportedAt: options.exportedAt, perspective, includePrivate, ordering: NDJSON_ORDERING,
    documentCount: chunks.length, byteLength: bytes, sha256: hash.digest('hex'),
    counts: { byType: Object.fromEntries(types.map(t => [t, byType.get(t)!])), byVariant },
    omitted: { unregisteredType: unregistered }, redactedSecretKeyCount: redacted,
    schema: {
      envelope: 'sanity-document-v1',
      craftSchemaVersions: Object.fromEntries(types.flatMap(t => { const d = options.registry.get(t); return d ? [[t, d.schemaVersion]] : []; })),
      unregisteredTypes: types.filter(t => !options.registry.get(t))
    },
    limits
  };
  return { bytes: Buffer.concat(chunks), manifest };
}

/** Length, SHA-256 and document count against a manifest from `serializeNdjson`. Detects corruption, not a coordinated edit of both. */
export function verifyNdjson(bytes: Uint8Array, manifest: Pick<NdjsonManifest, 'byteLength' | 'sha256' | 'documentCount'>): boolean {
  if (!(bytes instanceof Uint8Array) || bytes.length !== manifest.byteLength) return false;
  if (createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) return false;
  try { return parseNdjson(bytes, { limits: NDJSON_LIMIT_CEILINGS }).documents.length === manifest.documentCount; } catch { return false; }
}

// ---------------------------------------------------------------------------------------------
// Parsing: strict, bounded, prototype-less objects
// ---------------------------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** Strict JSON incl. decoded-key uniqueness. Budgets are checked while parsing, before collections are built. */
export function parseRecord(raw: string): Json {
  let at = 0, nodes = 0;
  const invalid = (code: CraftErrorCode): never => { throw new CraftError(code); };
  const whitespace = () => { while (/[\x20\t\r\n]/.test(raw[at] ?? 'x')) at++; };
  function string(): string {
    const start = at++;
    while (at < raw.length) {
      const c = raw[at++];
      if (at - start > JSON_LIMITS.string * 6 + 2) invalid('string_limit');
      if (c === '\\') { at++; continue; }
      if (c !== '"') continue;
      let value: string;
      try { value = JSON.parse(raw.slice(start, at)); } catch { return invalid('json'); }
      if (value.length > JSON_LIMITS.string) invalid('string_limit');
      if (MALFORMED_UTF16.test(value)) invalid('unicode');
      return value;
    }
    return invalid('json');
  }
  function value(depth: number): Json {
    if (++nodes > JSON_LIMITS.nodes) invalid('node_limit');
    if (depth > JSON_LIMITS.depth) invalid('depth_limit');
    whitespace();
    const c = raw[at];
    if (c === '"') return string();
    if (c === '{' || c === '[') {
      const array = c === '[', end = array ? ']' : '}';
      at++; whitespace();
      const output: Json[] | Record<string, Json> = array ? [] : Object.create(null);
      const seen = new Set<string>();
      let count = 0;
      if (raw[at] === end) { at++; return output; }
      while (at < raw.length) {
        if (++count > (array ? JSON_LIMITS.array : JSON_LIMITS.properties)) invalid('collection_limit');
        whitespace();
        if (array) (output as Json[]).push(value(depth + 1));
        else {
          if (raw[at] !== '"') invalid('json');
          const key = string();
          if (UNSAFE_KEYS.has(key)) invalid('unsafe_key');
          if (seen.has(key)) invalid('duplicate_key');
          seen.add(key); whitespace();
          if (raw[at++] !== ':') invalid('json');
          (output as Record<string, Json>)[key] = value(depth + 1);
        }
        whitespace();
        if (raw[at] === end) { at++; return output; }
        if (raw[at++] !== ',') invalid('json');
      }
      return invalid('json');
    }
    for (const [token, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (raw.startsWith(token, at)) { at += token.length; return result; }
    }
    const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(raw.slice(at, at + 400));
    if (!token) return invalid('json');
    at += token[0].length;
    const number = Number(token[0]);
    if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number))) invalid('number');
    return number;
  }
  const output = value(0); whitespace();
  if (at !== raw.length) invalid('json');
  return output;
}

export type ParsedDocument = { _id: string; _type: string; [key: string]: unknown };
export type ParsedNdjson = { documents: ParsedDocument[]; stats: { bytes: number; sha256: string; records: number; blanks: number } };

/**
 * Strict line reader: fatal UTF-8 per line, one leading BOM allowed, CR only as part of CRLF, blank lines skipped and
 * counted, byte/line/record limits, duplicate and unsafe keys rejected, top-level `_id`/`_type` required, `_id`s unique.
 * Errors carry the physical line number only.
 */
export function parseNdjson(input: Uint8Array, options: { limits?: Partial<NdjsonLimits> } = {}): ParsedNdjson {
  if (!(input instanceof Uint8Array)) return fail('invalid_options');
  const limits = resolveNdjsonLimits(options?.limits);
  if (input.length > limits.maxTotalBytes) return fail('file_limit');
  const documents: ParsedDocument[] = [];
  const ids = new Set<string>();
  let records = 0, blanks = 0, line = 0, start = 0;
  const lineFail = (code: CraftErrorCode): never => { throw new CraftError(code, { line }); };
  while (start < input.length) {
    let end = input.indexOf(10, start);
    if (end === -1) end = input.length;
    line++;
    if (end - start > limits.maxLineBytes) lineFail('line_limit');
    let data = input.subarray(start, end);
    start = end + 1;
    if (line === 1 && data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) data = data.subarray(3);
    if (data[data.length - 1] === 13) data = data.subarray(0, -1);
    let raw: string;
    try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); } catch { return lineFail('utf8'); }
    if (raw.includes('\ufeff')) lineFail('bom');
    if (/^[\x20\t\r]*$/.test(raw)) { blanks++; continue; }
    if (++records > limits.maxDocuments) lineFail('record_limit');
    let parsed: Json;
    try { parsed = parseRecord(raw); } catch (error) { return lineFail(error instanceof CraftError ? error.code : 'json'); }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return lineFail('identity');
    const { _id, _type } = parsed as Record<string, unknown>;
    if (typeof _id !== 'string' || !_id.length || _id.length > 1024 || _id === 'drafts.' || typeof _type !== 'string' || !_type.length || _type.length > 1024) return lineFail('identity');
    if (ids.has(_id)) return lineFail('duplicate_id');
    ids.add(_id);
    documents.push(parsed as ParsedDocument);
  }
  return { documents, stats: { bytes: input.length, sha256: createHash('sha256').update(input).digest('hex'), records, blanks } };
}

/** groq-js cannot evaluate prototype-less objects; this copies parsed documents into ordinary objects (keys were already vetted). */
export function toQueryDocuments(documents: readonly ParsedDocument[]): QueryDocument[] {
  return documents.map(doc => JSON.parse(JSON.stringify(doc)) as QueryDocument);
}
