/**
 * @jongo/craft/server: server-only persistence for Craft. Never import this from client code or Studio components
 * (it needs Node APIs and a database); a test enforces that the client entry does not reach it.
 */
export { CraftError, type CraftErrorCode, type ValidationIssue } from './errors.js';
export { assertContext, type Authorize, type CraftAction, type CraftContext } from './auth.js';
export { createPgExecutor, type PgPoolLike, type PgQueryable, type Queryable, type QueryResult, type SqlExecutor, type TransactionOptions } from './executor.js';
export { loadMigrations, migrationChecksum, migrationsDir, runMigrations, type Migration, type MigrationReport } from './migrate.js';
export { createDataset, getDataset, type DatasetInfo } from './datasets.js';
export {
  discardDraft, getDocument, listDocuments, publishDocument, saveDraft, unpublishDocument,
  type DocumentMutationResult, type DocumentSummary, type GetDocumentInput, type GetDocumentResult, type ListDocumentsInput, type ListDocumentsResult, type SaveDraftInput
} from './documents.js';
export type { SchemaRegistry } from './docs-core.js';
export { queryDataset, exportNdjson, type ExportNdjsonInput, type QueryDatasetInput } from './dataset-read.js';
export { importNdjson, type ImportEntry, type ImportNdjsonInput, type ImportResult, type ImportSummary } from './import.js';
export {
  NDJSON_FORMAT, NDJSON_DEFAULT_LIMITS, NDJSON_LIMIT_CEILINGS, parseNdjson, serializeNdjson, toQueryDocuments, verifyNdjson,
  type NdjsonLimits, type NdjsonManifest, type NdjsonSerializeOptions, type ParsedDocument, type ParsedNdjson
} from './ndjson.js';
export { applyPerspective, QUERY_DEFAULT_LIMITS, runGroq, type Consumer, type Perspective, type QueryDocument, type QueryLimits, type RunGroqInput, type RunGroqResult } from './query/groq.js';
export { toPublicDocument } from './query/privacy.js';
export { MAX_AUDIT_DETAIL_BYTES, isSecretKey, redact } from './redact.js';
export { MAX_DOCUMENT_BYTES, canonicalJson, findJsonViolation, sha256Hex } from './json.js';
