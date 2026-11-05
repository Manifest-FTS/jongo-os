/** Typed errors with fixed messages. Messages never contain document content, SQL text or driver errors. */
export type CraftErrorCode =
  // caller / authorization
  | 'invalid_input' | 'denied' | 'not_found' | 'dataset_exists'
  // concurrency and idempotency
  | 'conflict' | 'precondition_required' | 'idempotency_conflict'
  // documents
  | 'validation_failed' | 'unknown_type' | 'invalid_document' | 'limit_exceeded' | 'unsafe_content'
  // infrastructure
  | 'unavailable' | 'dependency_missing'
  | 'migration_invalid' | 'migration_failed' | 'migration_checksum_mismatch' | 'migration_missing'
  // GROQ
  | 'invalid_query' | 'query_too_long' | 'invalid_params' | 'params_too_large' | 'invalid_documents' | 'too_many_documents'
  | 'invalid_options' | 'invalid_perspective' | 'result_too_large' | 'timeout' | 'evaluation_failed' | 'dataset_too_large'
  // NDJSON
  | 'duplicate_id' | 'line_too_large' | 'output_too_large' | 'utf8' | 'bom' | 'json' | 'duplicate_key' | 'unsafe_key'
  | 'unicode' | 'number' | 'string_limit' | 'node_limit' | 'depth_limit' | 'collection_limit' | 'line_limit' | 'file_limit'
  | 'record_limit' | 'identity';

const MESSAGES: Record<CraftErrorCode, string> = {
  invalid_input: 'Input is invalid.',
  denied: 'Craft operation denied.',
  not_found: 'Not found.',
  dataset_exists: 'Dataset already exists.',
  conflict: 'The document changed or already exists.',
  precondition_required: 'Expected revision or lock version is required to change an existing document.',
  idempotency_conflict: 'The mutation key was already used for a different request.',
  validation_failed: 'Document failed validation.',
  unknown_type: 'Document type is not registered.',
  invalid_document: 'Document cannot be represented as safe JSON.',
  limit_exceeded: 'A size or count limit was exceeded.',
  unsafe_content: 'Document contains unsafe content.',
  unavailable: 'Craft storage unavailable.',
  dependency_missing: 'An optional dependency required for this operation is not installed.',
  migration_invalid: 'Migration files are invalid.',
  migration_failed: 'Migration failed.',
  migration_checksum_mismatch: 'An applied migration no longer matches its recorded checksum.',
  migration_missing: 'An applied migration is missing from this package.',
  invalid_query: 'Query is not valid GROQ.',
  query_too_long: 'Query exceeds the maximum length.',
  invalid_params: 'Query parameters must be plain JSON values.',
  params_too_large: 'Query parameters exceed the maximum size.',
  invalid_documents: 'Document set is invalid.',
  too_many_documents: 'Document set exceeds the maximum size.',
  invalid_options: 'Options are invalid.',
  invalid_perspective: 'Unknown perspective.',
  result_too_large: 'Query result exceeds the maximum size.',
  timeout: 'Query exceeded its time budget.',
  evaluation_failed: 'Query evaluation failed.',
  dataset_too_large: 'Dataset exceeds the queryable size.',
  duplicate_id: 'Document _id values must be unique.',
  line_too_large: 'A serialized document exceeds the per-line size limit.',
  output_too_large: 'Serialized output exceeds the size limit.',
  utf8: 'Input is not valid UTF-8.',
  bom: 'Misplaced byte-order mark.',
  json: 'Line is not valid JSON.',
  duplicate_key: 'Duplicate object key.',
  unsafe_key: 'Unsafe object key.',
  unicode: 'Invalid Unicode in a string.',
  number: 'Number is not a safe finite JSON number.',
  string_limit: 'String exceeds the size limit.',
  node_limit: 'Document has too many values.',
  depth_limit: 'Document is nested too deeply.',
  collection_limit: 'Array or object has too many entries.',
  line_limit: 'Line exceeds the size limit.',
  file_limit: 'Input exceeds the size limit.',
  record_limit: 'Too many records.',
  identity: 'Record has no valid _id and _type.'
};

export type ValidationIssue = { path: readonly (string | number)[]; code: string; message: string };
export type CraftErrorDetail = {
  /** Only for invalid_query: derived from the query text, never from documents. */
  message?: string; position?: number; line?: number; column?: number;
  issues?: readonly ValidationIssue[]; documentId?: string; migration?: string;
};

export class CraftError extends Error {
  readonly position?: number;
  readonly line?: number;
  readonly column?: number;
  readonly issues?: readonly ValidationIssue[];
  /** Locator only (an id the caller supplied), never content. */
  readonly documentId?: string;
  readonly migration?: string;
  constructor(public readonly code: CraftErrorCode, detail: CraftErrorDetail = {}) {
    super(detail.message ?? MESSAGES[code]);
    this.name = 'CraftError';
    this.position = detail.position; this.line = detail.line; this.column = detail.column;
    this.issues = detail.issues; this.documentId = detail.documentId; this.migration = detail.migration;
  }
}
export const fail = (code: CraftErrorCode, detail?: CraftErrorDetail): never => { throw new CraftError(code, detail); };

/** Maps any thrown value to a CraftError. Driver errors are reduced to a fixed message: no SQL, parameters or row data. */
export function toCraftError(error: unknown): CraftError {
  if (error instanceof CraftError) return error;
  const sqlstate = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (sqlstate === '23505') return new CraftError('conflict');
  return new CraftError('unavailable');
}
