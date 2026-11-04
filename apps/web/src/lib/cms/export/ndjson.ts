/**
 * Sanity-export-compatible NDJSON (`data.ndjson`) for Jongo CMS documents. Pure: no DB, network,
 * env or filesystem access. The caller supplies already-authorized, single-dataset envelope
 * documents (the shape `runGroq` consumes); this module applies perspective, privacy,
 * secret scrubbing, bounds, deterministic ordering and integrity metadata.
 *
 * Format ("jongo-ndjson-v1"): UTF-8, no BOM, LF line endings, one JSON object per line, each a
 * full document (`_id,_type,_rev,_createdAt,_updatedAt` + payload), trailing newline after every
 * line. Documents are ordered by logical id, then variant (published, draft, version), then `_id`.
 * Object keys are sorted at every depth (array order is preserved) so equal input gives equal
 * bytes. U+0085, U+2028 and U+2029 are written as `\u` escapes: valid JSON that decodes to the same
 * string, but never a raw character that some line splitters treat as a line break.
 *
 * Secrets: documents of NEVER_EXPORT_TYPES are omitted and properties whose NAME looks secret
 * (isSecretKey) are dropped at any depth, even with `includePrivate`. This is a key-name
 * heuristic; it cannot find a secret stored as a value under an innocent key.
 *
 * Streaming: `streamNdjson` yields one Buffer per line (memory per line is capped by
 * `maxLineBytes`) and returns the manifest as the generator's return value. If it throws, the
 * output so far is incomplete and must be discarded.
 */
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { ImportError, parseRecord, READER_LIMITS } from "../import/reader";
import { applyPerspective, type CmsQueryDocument, type CmsQueryPerspective } from "../query/groq";
import { toPublicDocument } from "../query/privacy";
import type { SchemaRegistry } from "../schema";
import { cmsSchemaRegistry } from "../schemas";
import { inspectJson, isTimestamp, LIMITS } from "../validation";

export const NDJSON_FORMAT = "jongo-ndjson-v1" as const;
export const NDJSON_ORDERING = "logicalId,variant,_id" as const;

export type NdjsonErrorCode =
  // options / documents (serialize)
  | "invalid_options" | "invalid_perspective" | "invalid_document" | "duplicate_id"
  | "too_many_documents" | "line_too_large" | "output_too_large"
  // parse (same codes as the importer reader where the check is shared)
  | "utf8" | "bom" | "json" | "duplicate_key" | "unsafe_key" | "unicode" | "number"
  | "string_limit" | "node_limit" | "depth_limit" | "collection_limit"
  | "line_limit" | "file_limit" | "record_limit" | "identity"
  // service
  | "denied" | "unavailable" | "dataset_too_large";

const MESSAGES: Record<NdjsonErrorCode, string> = {
  invalid_options: "NDJSON options are invalid.",
  invalid_perspective: "Unknown perspective.",
  invalid_document: "A document cannot be represented as export-safe JSON.",
  duplicate_id: "Document _id values must be unique.",
  too_many_documents: "Document count exceeds the limit.",
  line_too_large: "A serialized document exceeds the per-line size limit.",
  output_too_large: "Serialized output exceeds the size limit.",
  utf8: "Input is not valid UTF-8.",
  bom: "Misplaced byte-order mark.",
  json: "Line is not valid JSON.",
  duplicate_key: "Duplicate object key.",
  unsafe_key: "Unsafe object key.",
  unicode: "Invalid Unicode in a string.",
  number: "Number is not a safe finite JSON number.",
  string_limit: "String exceeds the size limit.",
  node_limit: "Document has too many values.",
  depth_limit: "Document is nested too deeply.",
  collection_limit: "Array or object has too many entries.",
  line_limit: "Line exceeds the size limit.",
  file_limit: "Input exceeds the size limit.",
  record_limit: "Too many records.",
  identity: "Record has no valid _id and _type.",
  denied: "CMS export denied.",
  unavailable: "CMS export unavailable.",
  dataset_too_large: "Dataset exceeds the exportable size."
};

/** Typed error. The message is fixed text: it never contains document content. `documentId`/`line` are locators only. */
export class CmsNdjsonError extends Error {
  constructor(public readonly code: NdjsonErrorCode, public readonly line = 0, public readonly documentId?: string) {
    super(`${MESSAGES[code]}${line ? ` (physical line ${line})` : ""}`);
    this.name = "CmsNdjsonError";
  }
}
const fail = (code: NdjsonErrorCode, line = 0, documentId?: string): never => { throw new CmsNdjsonError(code, line, documentId); };

export type NdjsonLimits = { maxDocuments: number; maxLineBytes: number; maxTotalBytes: number };
/** Defaults equal the importer's reader limits, so a default export can be read back by `readNdjson`/`planImport`. */
export const NDJSON_DEFAULT_LIMITS: Readonly<NdjsonLimits> = Object.freeze({
  maxDocuments: READER_LIMITS.records, maxLineBytes: READER_LIMITS.line, maxTotalBytes: READER_LIMITS.file
});
/** Callers may lower limits or raise them only up to these ceilings. Raising past the defaults produces files Jongo's own importer reader refuses. */
export const NDJSON_LIMIT_CEILINGS: Readonly<NdjsonLimits> = Object.freeze({
  maxDocuments: 100_000, maxLineBytes: 8 * 1024 * 1024, maxTotalBytes: 128 * 1024 * 1024
});

export function resolveNdjsonLimits(limits: Partial<NdjsonLimits> | undefined): NdjsonLimits {
  const resolved = { ...NDJSON_DEFAULT_LIMITS };
  if (limits === undefined) return resolved;
  if (typeof limits !== "object" || limits === null) return fail("invalid_options");
  for (const key of Object.keys(NDJSON_LIMIT_CEILINGS) as (keyof NdjsonLimits)[]) {
    const value = limits[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 1 || value > NDJSON_LIMIT_CEILINGS[key]) return fail("invalid_options");
    resolved[key] = value;
  }
  return resolved;
}

/**
 * Types that are never exported, with or without `includePrivate`. Mirrors the importer's
 * `EXCLUDED` map in import/planner.ts (not exported there; import/** was out of scope to edit).
 * A test pins the two lists together.
 */
export const NEVER_EXPORT_TYPES: ReadonlySet<string> = new Set(["mux.apiKey", "pageNotFound", "notificationRequest"]);

/** Property NAMES that look like credentials (case-insensitive, punctuation ignored). */
const SECRET_KEY = /apikey|secret(?!ar)|passw(?:or)?d|passphrase|privatekey|signingkey|credential|token$|^authorization$|^cookie$/;
export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

type Variant = "published" | "draft" | "version";
const variantOf = (id: string): Variant => id.startsWith("drafts.") ? "draft" : id.startsWith("versions.") ? "version" : "published";
const logicalOf = (id: string) => id.startsWith("drafts.") ? id.slice("drafts.".length) : id;
const VARIANT_RANK: Record<Variant, number> = { published: 0, draft: 1, version: 2 };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function byExportOrder(a: CmsQueryDocument, b: CmsQueryDocument): number {
  return compare(logicalOf(a._id), logicalOf(b._id)) || VARIANT_RANK[variantOf(a._id)] - VARIANT_RANK[variantOf(b._id)] || compare(a._id, b._id);
}

export type NdjsonSerializeOptions = {
  /** Injected (never read from the clock) so output is deterministic. UTC ISO timestamp. */
  exportedAt: string;
  /** Default "published". "raw" is the faithful backup (keeps `drafts.` ids); "previewDrafts" is a merged view and loses draft/published pairing. */
  perspective?: CmsQueryPerspective;
  /** Default false. Must be exactly `true` to keep schema-`private` and undeclared fields and unregistered types. Secrets are removed regardless. */
  includePrivate?: boolean;
  limits?: Partial<NdjsonLimits>;
  /** Test seam; defaults to the cms schema registry. */
  registry?: SchemaRegistry;
};

export type NdjsonManifest = {
  format: typeof NDJSON_FORMAT;
  exportedAt: string;
  perspective: CmsQueryPerspective;
  includePrivate: boolean;
  ordering: typeof NDJSON_ORDERING;
  documentCount: number;
  /** Exact length of the NDJSON bytes. */
  byteLength: number;
  /** SHA-256 (hex) of the exact NDJSON bytes. Integrity against corruption, not authenticity: the manifest is unsigned. */
  sha256: string;
  counts: { byType: Record<string, number>; byVariant: Record<Variant, number> };
  /** Documents left out on purpose; counts only, never ids. */
  omitted: { excludedType: number; unregisteredType: number };
  /** Number of properties dropped because their name looked secret (never their names or values). */
  redactedSecretKeyCount: number;
  schema: { envelope: "sanity-document-v1"; jongoSchemaVersions: Record<string, number>; unregisteredTypes: string[] };
  limits: NdjsonLimits;
};

const MALFORMED_UTF16 = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const LINE_BREAKERS = /[\u0085\u2028\u2029]/g;
const escapeUnit = (c: string) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;

function encodeString(value: string, id: string): string {
  // Same string rules as the importer reader, so every emitted line can be read back.
  if (value.length > LIMITS.string || MALFORMED_UTF16.test(value)) return fail("invalid_document", 0, id);
  return JSON.stringify(value).replace(LINE_BREAKERS, escapeUnit);
}

/** Canonical single-line JSON. Output size is checked while building, so memory stays near `maxLineBytes`. */
function encodeDocument(doc: Record<string, unknown>, id: string, maxLineBytes: number): { line: string; redacted: number } {
  const parts: string[] = [];
  let chars = 0, redacted = 0;
  const emit = (text: string) => {
    // Encoded chars are a lower bound on bytes, so exceeding the cap here always means exceeding it in bytes.
    chars += text.length;
    if (chars > maxLineBytes) fail("line_too_large", 0, id);
    parts.push(text);
  };
  const walk = (value: unknown): void => {
    if (value === null) return emit("null");
    switch (typeof value) {
      case "boolean": return emit(value ? "true" : "false");
      case "number":
        if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) return fail("invalid_document", 0, id);
        return emit(JSON.stringify(value));
      case "string": return emit(encodeString(value, id));
      case "object": {
        if (Array.isArray(value)) {
          emit("[");
          value.forEach((item, index) => { if (index) emit(","); walk(item); });
          return emit("]");
        }
        emit("{");
        let first = true;
        for (const key of Object.keys(value as object).sort()) {
          if (isSecretKey(key)) { redacted++; continue; }
          if (!first) emit(",");
          first = false;
          emit(encodeString(key, id)); emit(":");
          walk((value as Record<string, unknown>)[key]);
        }
        return emit("}");
      }
      default: return fail("invalid_document", 0, id);
    }
  };
  walk(doc);
  return { line: parts.join(""), redacted };
}

function collect(documents: Iterable<CmsQueryDocument>, limits: NdjsonLimits): CmsQueryDocument[] {
  if (documents === null || typeof documents !== "object" || typeof (documents as Iterable<unknown>)[Symbol.iterator] !== "function") return fail("invalid_document");
  const out: CmsQueryDocument[] = [];
  const seen = new Set<string>();
  const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024;
  for (const doc of documents) {
    if (out.length >= limits.maxDocuments) return fail("too_many_documents");
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return fail("invalid_document");
    const { _id, _type, _rev, _createdAt, _updatedAt } = doc as Record<string, unknown>;
    if (!text(_id) || _id === "drafts." || !text(_type) || !text(_rev) || !isTimestamp(_createdAt) || !isTimestamp(_updatedAt)) {
      return fail("invalid_document", 0, typeof _id === "string" ? _id.slice(0, 200) : undefined);
    }
    if (seen.has(_id)) return fail("duplicate_id", 0, _id);
    seen.add(_id);
    out.push(doc);
  }
  return out;
}

/**
 * Generator form: yields one NDJSON line (Buffer, including its trailing "\n") at a time and
 * returns the manifest. Options, envelopes, duplicates and the document cap are validated
 * before the first line is produced; per-document errors can still throw mid-stream, and then
 * the partial output must be discarded.
 */
export function streamNdjson(documents: Iterable<CmsQueryDocument>, options: NdjsonSerializeOptions): Generator<Buffer, NdjsonManifest, undefined> {
  if (typeof options !== "object" || options === null || !isTimestamp(options.exportedAt)) return fail("invalid_options");
  const perspective = options.perspective ?? "published";
  if (perspective !== "published" && perspective !== "previewDrafts" && perspective !== "raw") return fail("invalid_perspective");
  if (options.includePrivate !== undefined && typeof options.includePrivate !== "boolean") return fail("invalid_options");
  const includePrivate = options.includePrivate === true;
  const limits = resolveNdjsonLimits(options.limits);
  const registry = options.registry ?? cmsSchemaRegistry;

  // Sort copies; the caller's array and documents are never mutated.
  const ordered = applyPerspective(collect(documents, limits), perspective).sort(byExportOrder);
  return lines(ordered, { exportedAt: options.exportedAt, perspective, includePrivate, limits, registry });
}

function* lines(ordered: CmsQueryDocument[], o: { exportedAt: string; perspective: CmsQueryPerspective; includePrivate: boolean; limits: NdjsonLimits; registry: SchemaRegistry }): Generator<Buffer, NdjsonManifest, undefined> {
  const { includePrivate, limits, registry, perspective } = o;
  const hash = createHash("sha256");
  const byType = new Map<string, number>();
  const byVariant: Record<Variant, number> = { published: 0, draft: 0, version: 0 };
  const omitted = { excludedType: 0, unregisteredType: 0 };
  let bytes = 0, count = 0, redacted = 0;

  for (const doc of ordered) {
    if (NEVER_EXPORT_TYPES.has(doc._type)) { omitted.excludedType++; continue; }
    const source = includePrivate ? doc : toPublicDocument(doc, registry);
    if (!source) { omitted.unregisteredType++; continue; }
    if (inspectJson(source).length) return fail("invalid_document", 0, doc._id.slice(0, 200));
    const encoded = encodeDocument(source, doc._id.slice(0, 200), limits.maxLineBytes);
    const chunk = Buffer.from(`${encoded.line}\n`, "utf8");
    if (chunk.length - 1 > limits.maxLineBytes) return fail("line_too_large", 0, doc._id.slice(0, 200));
    bytes += chunk.length;
    if (bytes > limits.maxTotalBytes) return fail("output_too_large");
    hash.update(chunk);
    redacted += encoded.redacted;
    count++;
    byType.set(doc._type, (byType.get(doc._type) ?? 0) + 1);
    byVariant[variantOf(doc._id)]++;
    yield chunk;
  }

  const types = [...byType.keys()].sort();
  return {
    format: NDJSON_FORMAT, exportedAt: o.exportedAt, perspective, includePrivate, ordering: NDJSON_ORDERING,
    documentCount: count, byteLength: bytes, sha256: hash.digest("hex"),
    counts: { byType: Object.fromEntries(types.map((type) => [type, byType.get(type)!])), byVariant },
    omitted, redactedSecretKeyCount: redacted,
    schema: {
      envelope: "sanity-document-v1",
      jongoSchemaVersions: Object.fromEntries(types.flatMap((type) => { const d = registry.get(type); return d ? [[type, d.schemaVersion]] : []; })),
      unregisteredTypes: types.filter((type) => !registry.get(type))
    },
    limits
  };
}

/** Whole-file convenience over `streamNdjson`. All or nothing. */
export function serializeNdjson(documents: Iterable<CmsQueryDocument>, options: NdjsonSerializeOptions): { bytes: Buffer; manifest: NdjsonManifest } {
  const chunks: Buffer[] = [];
  const stream = streamNdjson(documents, options);
  let step = stream.next();
  while (!step.done) { chunks.push(step.value); step = stream.next(); }
  return { bytes: Buffer.concat(chunks), manifest: step.value };
}

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

export type ParsedDocument = { _id: string; _type: string; [key: string]: unknown };
export type ParsedNdjson = { documents: ParsedDocument[]; stats: { bytes: number; sha256: string; records: number; blanks: number } };

const PARSE_CODES: ReadonlySet<string> = new Set(["utf8", "bom", "json", "duplicate_key", "unsafe_key", "unicode", "number",
  "string_limit", "node_limit", "depth_limit", "collection_limit", "line_limit", "file_limit", "record_limit"]);
const BOM = [0xef, 0xbb, 0xbf];

/**
 * Incremental line reader. Mirrors `readNdjson` in import/reader.ts (strict fatal UTF-8 per line,
 * single leading BOM, CR as part of CRLF, blank lines skipped and counted, line/record/file
 * limits, `parseRecord` for duplicate-key/prototype-key/number/depth budgets). `readNdjson` itself
 * only reads a file path, so the splitting and UTF-8 handling (about 25 lines) are repeated
 * here; everything else is called, not copied. Added beyond the reader: top-level `_id`/`_type`
 * and duplicate `_id` checks (the planner does those later).
 */
class NdjsonAccumulator {
  private readonly hash = createHash("sha256");
  private readonly documents: ParsedDocument[] = [];
  private readonly ids = new Set<string>();
  private parts: Uint8Array[] = [];
  private used = 0;
  private bytes = 0; private line = 0; private records = 0; private blanks = 0;
  constructor(private readonly limits: NdjsonLimits) {}

  push(chunk: Uint8Array): void {
    if (!(chunk instanceof Uint8Array)) return fail("invalid_options");
    this.bytes += chunk.length;
    if (this.bytes > this.limits.maxTotalBytes) return fail("file_limit");
    this.hash.update(chunk);
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      if (end > start) {
        if (this.used + (end - start) > this.limits.maxLineBytes) return fail("line_limit", this.line + 1);
        this.parts.push(chunk.subarray(start, end));
        this.used += end - start;
      }
      if (newline === -1) return;
      this.consume();
      start = newline + 1;
    }
  }

  private consume(): void {
    this.line++;
    const length = this.used;
    let data: Uint8Array = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, length);
    this.parts = []; this.used = 0;
    if (this.line === 1 && data.length >= 3 && data[0] === BOM[0] && data[1] === BOM[1] && data[2] === BOM[2]) data = data.subarray(3);
    if (data[data.length - 1] === 13) data = data.subarray(0, -1);
    let raw: string;
    try { raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data); }
    catch { return fail("utf8", this.line); }
    if (raw.includes("\ufeff")) return fail("bom", this.line);
    if (/^[\x20\t\r]*$/.test(raw)) { this.blanks++; return; }
    if (++this.records > this.limits.maxDocuments) return fail("record_limit", this.line);
    let value: unknown;
    try { value = parseRecord(raw); }
    catch (error) {
      const code = error instanceof ImportError && PARSE_CODES.has(error.code) ? error.code as NdjsonErrorCode : "json";
      return fail(code, this.line);
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return fail("identity", this.line);
    const { _id, _type } = value as Record<string, unknown>;
    if (typeof _id !== "string" || !_id.length || _id.length > 1024 || _id === "drafts." || typeof _type !== "string" || !_type.length || _type.length > 1024) return fail("identity", this.line);
    if (this.ids.has(_id)) return fail("duplicate_id", this.line);
    this.ids.add(_id);
    this.documents.push(value as ParsedDocument);
  }

  end(): ParsedNdjson {
    if (this.used) this.consume();
    return { documents: this.documents, stats: { bytes: this.bytes, sha256: this.hash.digest("hex"), records: this.records, blanks: this.blanks } };
  }
}

/**
 * Parsed objects are prototype-less (as in the importer reader) so keys can never pollute. groq-js
 * cannot evaluate prototype-less objects, so use this to hand parsed documents to `runGroq`.
 */
export function toQueryDocuments(documents: readonly ParsedDocument[]): CmsQueryDocument[] {
  // The parser already rejected `__proto__`/`constructor`/`prototype` keys at every depth.
  return documents.map((doc) => JSON.parse(JSON.stringify(doc)) as CmsQueryDocument);
}

/** Defaults are the importer reader's limits; callers may tighten them or raise them to NDJSON_LIMIT_CEILINGS. */
export function parseNdjson(input: Uint8Array | Iterable<Uint8Array>, options: { limits?: Partial<NdjsonLimits> } = {}): ParsedNdjson {
  const accumulator = new NdjsonAccumulator(resolveNdjsonLimits(options?.limits));
  if (input instanceof Uint8Array) accumulator.push(input);
  else if (input !== null && typeof input === "object" && typeof (input as Iterable<Uint8Array>)[Symbol.iterator] === "function") {
    for (const chunk of input) accumulator.push(chunk);
  } else return fail("invalid_options");
  return accumulator.end();
}

/** Same as `parseNdjson` for async byte sources such as `fs.createReadStream`. */
export async function parseNdjsonAsync(input: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Uint8Array, options: { limits?: Partial<NdjsonLimits> } = {}): Promise<ParsedNdjson> {
  if (input instanceof Uint8Array || (input !== null && typeof input === "object" && Symbol.iterator in input)) return parseNdjson(input as Uint8Array | Iterable<Uint8Array>, options);
  if (input === null || typeof input !== "object" || typeof (input as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== "function") return fail("invalid_options");
  const accumulator = new NdjsonAccumulator(resolveNdjsonLimits(options?.limits));
  for await (const chunk of input as AsyncIterable<Uint8Array>) accumulator.push(chunk);
  return accumulator.end();
}

// ---------------------------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------------------------

export type NdjsonVerifyFailure =
  | "manifest_invalid" | "format_mismatch" | "byte_length_mismatch" | "sha256_mismatch"
  | "bom_present" | "missing_trailing_newline" | "blank_lines" | "document_count_mismatch" | "counts_mismatch"
  | `unparseable:${string}`;
export type NdjsonVerifyResult = { ok: true } | { ok: false; reasons: NdjsonVerifyFailure[] };

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function sameCounts(declared: unknown, actual: ReadonlyMap<string, number>): boolean {
  if (declared === null || typeof declared !== "object" || Array.isArray(declared)) return false;
  const keys = Object.keys(declared);
  if (keys.length !== actual.size) return false;
  return keys.every((key) => actual.get(key) === (declared as Record<string, unknown>)[key]);
}

/**
 * Checks `bytes` against a manifest produced by this module: exact length and SHA-256, no BOM,
 * trailing newline, no blank lines, that every line parses under the importer-aligned rules, and
 * that document/type/variant counts match. Detects corruption or edits of the file OR of the
 * manifest alone. It cannot detect a coordinated edit of both (the manifest is not signed).
 */
export function verifyNdjson(bytes: Uint8Array, manifest: NdjsonManifest): NdjsonVerifyResult {
  const m = manifest as unknown as Record<string, any>;
  const counts = m?.counts;
  if (!(bytes instanceof Uint8Array) || m === null || typeof m !== "object" || typeof m.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.sha256) ||
      !isCount(m.byteLength) || !isCount(m.documentCount) || typeof counts !== "object" || counts === null ||
      typeof counts.byVariant !== "object" || counts.byVariant === null) return { ok: false, reasons: ["manifest_invalid"] };
  const reasons: NdjsonVerifyFailure[] = [];
  if (m.format !== NDJSON_FORMAT) reasons.push("format_mismatch");
  if (bytes.length !== m.byteLength) reasons.push("byte_length_mismatch");
  if (createHash("sha256").update(bytes).digest("hex") !== m.sha256) reasons.push("sha256_mismatch");
  if (bytes.length >= 3 && bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2]) reasons.push("bom_present");
  if (bytes.length > 0 && bytes[bytes.length - 1] !== 10) reasons.push("missing_trailing_newline");
  try {
    const parsed = parseNdjson(bytes, { limits: NDJSON_LIMIT_CEILINGS });
    if (parsed.stats.blanks > 0) reasons.push("blank_lines");
    if (parsed.documents.length !== m.documentCount) reasons.push("document_count_mismatch");
    const types = new Map<string, number>();
    const variants = new Map<string, number>([["published", 0], ["draft", 0], ["version", 0]]);
    for (const doc of parsed.documents) {
      types.set(doc._type, (types.get(doc._type) ?? 0) + 1);
      const variant = variantOf(doc._id);
      variants.set(variant, variants.get(variant)! + 1);
    }
    if (!sameCounts(counts.byType, types) || !sameCounts(counts.byVariant, variants)) reasons.push("counts_mismatch");
  } catch (error) {
    reasons.push(`unparseable:${error instanceof CmsNdjsonError ? error.code : "unknown"}`);
  }
  return reasons.length ? { ok: false, reasons } : { ok: true };
}
