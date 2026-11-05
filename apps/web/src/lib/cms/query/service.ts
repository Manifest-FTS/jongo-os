/**
 * Authenticated GROQ query service over one dataset's CURRENT revisions.
 * Private Node-only: no HTTP route, no public API. `userId` must be the trusted session user.
 *
 * Authorization (re-checked, fail closed): CMS enabled + dataset read capability. A reader may
 * query only the `published` perspective with private schema fields stripped; editor or
 * above may also use `previewDrafts`/`raw`, and sees private fields. Drafts are unreviewed
 * work product and `raw` exposes `drafts.*` ids, so both need authoring rights.
 */
import { isUuid } from "@/lib/site-identity";
import { resolveDatasetCmsCapabilities } from "../dataset-access";
import { CmsDocumentError, withCmsReadTransaction } from "../documents";
import {
  CmsQueryError, runGroq, validateQueryInput,
  type CmsQueryDocument, type CmsQueryLimits, type CmsQueryPerspective
} from "./groq";

export type QueryCmsDatasetInput = {
  /** Trusted authenticated session ID, never a request-supplied principal. */
  userId: string;
  datasetId: string;
  query: string;
  params?: Record<string, unknown>;
  perspective?: CmsQueryPerspective;
  /** Server-side callers only; never forward client input. */
  limits?: Partial<CmsQueryLimits>;
};
export type QueryCmsDatasetResult = { result: unknown; ms: number; documentCount: number; perspective: CmsQueryPerspective };

/** Total decoded payload bytes held for one query; independent of the document count cap. */
const MAX_LOAD_BYTES = 64 * 1024 * 1024;
const REVISION_CHUNK = 100;
const EDITOR_RANK = 1;

const deny = (): never => { throw new CmsQueryError("denied"); };

export async function queryCmsDataset(input: QueryCmsDatasetInput): Promise<QueryCmsDatasetResult> {
  const { userId, datasetId } = input ?? ({} as QueryCmsDatasetInput);
  if (typeof window !== "undefined" || process.env.JONGO_CMS_ENABLED !== "true" ||
      typeof userId !== "string" || !isUuid(userId) || typeof datasetId !== "string" || !isUuid(datasetId)) return deny();
  const perspective = input.perspective ?? "published";
  if (perspective !== "published" && perspective !== "previewDrafts" && perspective !== "raw") {
    throw new CmsQueryError("invalid_perspective");
  }
  // Bad queries fail before any DB access.
  const { limits } = validateQueryInput({ query: input.query, params: input.params, limits: input.limits });

  const capabilities = await resolveDatasetCmsCapabilities(userId, datasetId);
  if (!capabilities.canRead || capabilities.datasetId !== datasetId) return deny();
  const editor = capabilities.canEdit;
  if (perspective !== "published" && !editor) return deny();

  let loaded: CmsQueryDocument[] | "dataset_too_large" | "unavailable";
  try {
    // The repository wrapper rewrites thrown errors, so failures are returned as markers.
    loaded = await withCmsReadTransaction({ userId, datasetId }, perspective === "published" ? 0 : EDITOR_RANK, async (tx) => {
      const rows = await tx.cmsDocument.findMany({
        where: { datasetId, archivedAt: null, currentRevisionId: { not: null },
          ...(perspective === "published" ? { variant: "published" } : {}) },
        select: { id: true, datasetId: true, nativeId: true, type: true, currentRevisionId: true, createdAt: true, updatedAt: true },
        orderBy: { id: "asc" }, take: limits.maxDocuments + 1
      });
      // Never silently truncate: a partial dataset would give wrong query answers.
      if (rows.length > limits.maxDocuments) return "dataset_too_large" as const;
      const out: CmsQueryDocument[] = [];
      let bytes = 0;
      for (let i = 0; i < rows.length; i += REVISION_CHUNK) {
        const chunk = rows.slice(i, i + REVISION_CHUNK);
        const revisions = await tx.cmsRevision.findMany({
          where: { datasetId, id: { in: chunk.map((row) => row.currentRevisionId) } },
          select: { id: true, datasetId: true, documentId: true, nativeRev: true, payload: true }
        });
        const byId = new Map(revisions.map((revision) => [revision.id, revision]));
        for (const row of chunk) {
          const revision = byId.get(row.currentRevisionId);
          const payload = revision?.payload;
          if (row.datasetId !== datasetId || !revision || revision.datasetId !== datasetId || revision.documentId !== row.id ||
              typeof payload !== "object" || payload === null || Array.isArray(payload)) {
            return "unavailable" as const;
          }
          bytes += Buffer.byteLength(JSON.stringify(payload), "utf8");
          if (bytes > MAX_LOAD_BYTES) return "dataset_too_large" as const;
          const body = payload as Record<string, unknown>;
          out.push({
            ...body,
            _id: row.nativeId, _type: row.type,
            _rev: typeof body._rev === "string" && body._rev ? body._rev : revision.nativeRev,
            _createdAt: typeof body._createdAt === "string" ? body._createdAt : new Date(row.createdAt).toISOString(),
            _updatedAt: typeof body._updatedAt === "string" ? body._updatedAt : new Date(row.updatedAt).toISOString()
          });
        }
      }
      return out;
    });
  } catch (error) {
    // Raw DB/SQL errors are never surfaced.
    throw new CmsQueryError(error instanceof CmsDocumentError && error.code === "denied" ? "denied" : "unavailable");
  }
  if (typeof loaded === "string") throw new CmsQueryError(loaded);
  const documents = loaded;

  const { result, ms, documentCount } = await runGroq({
    documents, query: input.query, params: input.params, perspective,
    consumer: editor ? "editor" : "public", limits: input.limits
  });
  return { result, ms, documentCount, perspective };
}
