/**
 * Pure GROQ evaluation over an in-memory Jongo document set, using Sanity's `groq-js`.
 *
 * No DB, network, env or filesystem access. The caller supplies already-authorized,
 * single-dataset envelope documents; this module applies perspective semantics,
 * schema privacy, input/output bounds and sanitized errors.
 *
 * Time budget caveat: evaluation runs in-process and is NOT cancellable. The budget is
 * enforced by racing a timer and by a cooperative check inside `->` dereference. A query
 * that never yields to the event loop can overrun it. Do not expose this to untrusted
 * anonymous callers without moving evaluation into a killable worker.
 */
import { evaluate, parse } from "groq-js";
import { cmsSchemaRegistry } from "../schemas";
import type { SchemaRegistry } from "../schema";
import { toPublicDocument } from "./privacy";

export type CmsQueryPerspective = "published" | "previewDrafts" | "raw";
export type CmsQueryConsumer = "public" | "editor";
export type CmsQueryErrorCode =
  | "invalid_query" | "query_too_long" | "invalid_params" | "params_too_large"
  | "invalid_documents" | "too_many_documents" | "invalid_options" | "invalid_perspective"
  | "result_too_large" | "timeout" | "evaluation_failed"
  | "denied" | "unavailable" | "dataset_too_large";

export type CmsQueryLimits = {
  maxQueryLength: number; maxDocuments: number; maxParamsBytes: number;
  maxResultBytes: number; timeoutMs: number;
};
export const CMS_QUERY_DEFAULT_LIMITS: Readonly<CmsQueryLimits> = Object.freeze({
  maxQueryLength: 10_000, maxDocuments: 10_000, maxParamsBytes: 64 * 1024,
  maxResultBytes: 5 * 1024 * 1024, timeoutMs: 5_000
});
/** Callers may lower limits or raise them only up to these ceilings. */
const CEILINGS: Readonly<CmsQueryLimits> = Object.freeze({
  maxQueryLength: 100_000, maxDocuments: 100_000, maxParamsBytes: 1024 * 1024,
  maxResultBytes: 32 * 1024 * 1024, timeoutMs: 30_000
});

const MESSAGES: Record<CmsQueryErrorCode, string> = {
  invalid_query: "Query is not valid GROQ.",
  query_too_long: "Query exceeds the maximum length.",
  invalid_params: "Query parameters must be plain JSON values.",
  params_too_large: "Query parameters exceed the maximum size.",
  invalid_documents: "Document set is invalid.",
  too_many_documents: "Document set exceeds the maximum size.",
  invalid_options: "Query options are invalid.",
  invalid_perspective: "Unknown perspective.",
  result_too_large: "Query result exceeds the maximum size.",
  timeout: "Query exceeded its time budget.",
  evaluation_failed: "Query evaluation failed.",
  denied: "CMS query denied.",
  unavailable: "CMS query unavailable.",
  dataset_too_large: "Dataset exceeds the queryable size."
};

/** Typed error. Message and position come from the query text or fixed strings, never document content. */
export class CmsQueryError extends Error {
  readonly position?: number;
  readonly line?: number;
  readonly column?: number;
  constructor(public readonly code: CmsQueryErrorCode, detail?: { message?: string; position?: number; line?: number; column?: number }) {
    super(detail?.message ?? MESSAGES[code]);
    this.name = "CmsQueryError";
    this.position = detail?.position;
    this.line = detail?.line;
    this.column = detail?.column;
  }
}
const fail = (code: CmsQueryErrorCode, detail?: ConstructorParameters<typeof CmsQueryError>[1]): never => {
  throw new CmsQueryError(code, detail);
};

export type CmsQueryDocument = Record<string, unknown> & { _id: string; _type: string };
export type RunGroqInput = {
  documents: readonly CmsQueryDocument[];
  query: string;
  params?: Record<string, unknown>;
  /** Default "published". */
  perspective?: CmsQueryPerspective;
  /** Default "public": private/undeclared schema fields are removed before evaluation. */
  consumer?: CmsQueryConsumer;
  limits?: Partial<CmsQueryLimits>;
  /** Test seam; defaults to the cms schema registry. */
  registry?: SchemaRegistry;
};
export type RunGroqResult = { result: unknown; ms: number; documentCount: number };

export function resolveLimits(limits: Partial<CmsQueryLimits> | undefined): CmsQueryLimits {
  const resolved = { ...CMS_QUERY_DEFAULT_LIMITS };
  if (limits === undefined) return resolved;
  if (typeof limits !== "object" || limits === null) return fail("invalid_options");
  for (const key of Object.keys(CEILINGS) as (keyof CmsQueryLimits)[]) {
    const value = limits[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 1 || value > CEILINGS[key]) return fail("invalid_options");
    resolved[key] = value;
  }
  return resolved;
}

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_PARAM_DEPTH = 16;
const MAX_PARAM_NODES = 10_000;

function cloneParam(value: unknown, depth: number, budget: { nodes: number }): unknown {
  if (++budget.nodes > MAX_PARAM_NODES || depth > MAX_PARAM_DEPTH) return fail("invalid_params");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : fail("invalid_params");
  if (Array.isArray(value)) return value.map((item) => cloneParam(item, depth + 1, budget));
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if ((proto !== Object.prototype && proto !== null) || Object.getOwnPropertySymbols(value).length) return fail("invalid_params");
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (key === "__proto__" || !descriptor || descriptor.get || descriptor.set) return fail("invalid_params");
      out[key] = cloneParam(descriptor.value, depth + 1, budget);
    }
    return out;
  }
  // undefined, function, symbol, bigint
  return fail("invalid_params");
}

/** Validates and detaches query/params before any document work or DB access. */
export function validateQueryInput(input: { query: unknown; params?: unknown; limits?: Partial<CmsQueryLimits> }): {
  query: string; params: Record<string, unknown>; limits: CmsQueryLimits;
} {
  const limits = resolveLimits(input.limits);
  if (typeof input.query !== "string" || input.query.trim().length === 0) return fail("invalid_query");
  if (input.query.length > limits.maxQueryLength) return fail("query_too_long");
  const raw = input.params ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail("invalid_params");
  const params = cloneParam(raw, 0, { nodes: 0 }) as Record<string, unknown>;
  for (const key of Object.keys(params)) if (!PARAM_NAME.test(key)) return fail("invalid_params");
  if (Buffer.byteLength(JSON.stringify(params), "utf8") > limits.maxParamsBytes) return fail("params_too_large");
  return { query: input.query, params, limits };
}

const DRAFT = "drafts.";
const isDraftId = (id: string) => id.startsWith(DRAFT);
const isVersionId = (id: string) => id.startsWith("versions.");

function validateDocuments(documents: unknown, limits: CmsQueryLimits): CmsQueryDocument[] {
  if (!Array.isArray(documents)) return fail("invalid_documents");
  if (documents.length > limits.maxDocuments) return fail("too_many_documents");
  const seen = new Set<string>();
  for (const doc of documents) {
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return fail("invalid_documents");
    const { _id, _type } = doc as Record<string, unknown>;
    if (typeof _id !== "string" || !_id.length || _id === DRAFT || typeof _type !== "string" || !_type.length || seen.has(_id)) return fail("invalid_documents");
    seen.add(_id);
  }
  return documents as CmsQueryDocument[];
}

/** Sanity perspective semantics over a flat document list. */
export function applyPerspective(documents: readonly CmsQueryDocument[], perspective: CmsQueryPerspective): CmsQueryDocument[] {
  if (perspective === "raw") return [...documents];
  if (perspective === "published") return documents.filter((d) => !isDraftId(d._id) && !isVersionId(d._id));
  const merged = new Map<string, CmsQueryDocument>();
  for (const doc of documents) {
    if (isVersionId(doc._id)) continue;
    if (!isDraftId(doc._id)) { if (!merged.has(doc._id)) merged.set(doc._id, doc); }
  }
  for (const doc of documents) {
    if (!isDraftId(doc._id)) continue;
    const logical = doc._id.slice(DRAFT.length);
    // Draft replaces its published sibling entirely: no field merging, no type merging.
    merged.set(logical, { ...doc, _id: logical });
  }
  return [...merged.values()];
}

class Deadline extends Error {}

export async function runGroq(input: RunGroqInput): Promise<RunGroqResult> {
  const started = performance.now();
  const { query, params, limits } = validateQueryInput(input);
  const perspective = input.perspective ?? "published";
  if (perspective !== "published" && perspective !== "previewDrafts" && perspective !== "raw") return fail("invalid_perspective");
  const consumer = input.consumer ?? "public";
  if (consumer !== "public" && consumer !== "editor") return fail("invalid_options");
  const registry = input.registry ?? cmsSchemaRegistry;

  const visible = applyPerspective(validateDocuments(input.documents, limits), perspective);
  let documents: CmsQueryDocument[] = visible;
  if (consumer === "public") {
    documents = [];
    for (const doc of visible) {
      const safe = toPublicDocument(doc, registry);
      if (safe) documents.push(safe as CmsQueryDocument);
    }
  }

  let tree;
  try { tree = parse(query, { params }); } catch (error) {
    // Parse-phase failures derive from the query text alone, never from documents.
    const e = error as { message?: unknown; position?: unknown; line?: unknown; column?: unknown };
    const message = typeof e?.message === "string" ? e.message.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 200) : undefined;
    return fail("invalid_query", { message, ...(typeof e?.position === "number" ? { position: e.position, line: e.line as number, column: e.column as number } : {}) });
  }

  // Dereference resolves only inside the perspective-filtered, privacy-filtered set.
  const byId = new Map<string, CmsQueryDocument>(documents.map((d) => [d._id, d]));
  const deadline = started + limits.timeoutMs;
  const dereference = ({ _ref }: { _ref: string }) => {
    if (performance.now() > deadline) throw new Deadline();
    return byId.get(_ref) ?? null;
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Deadline()), limits.timeoutMs);
  });
  const run = (async () => {
    const value = await evaluate(tree, { dataset: documents, params, dereference, identity: "" });
    return value.get();
  })();
  run.catch(() => {}); // the abandoned evaluation may still settle after a timeout

  let raw: unknown;
  try { raw = await Promise.race([run, timeout]); } catch (error) {
    // Never forward groq-js/runtime errors: they can embed values from documents.
    return error instanceof Deadline ? fail("timeout") : fail("evaluation_failed");
  } finally { clearTimeout(timer); }
  if (performance.now() - started > limits.timeoutMs) return fail("timeout");

  let encoded: string | undefined;
  try { encoded = JSON.stringify(raw ?? null); } catch { return fail("evaluation_failed"); }
  if (encoded === undefined) encoded = "null";
  if (Buffer.byteLength(encoded, "utf8") > limits.maxResultBytes) return fail("result_too_large");
  return { result: JSON.parse(encoded), ms: Math.round((performance.now() - started) * 100) / 100, documentCount: documents.length };
}
