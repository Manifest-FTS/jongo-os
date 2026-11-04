/**
 * Authenticated NDJSON export of one dataset's CURRENT revisions.
 * Private Node-only: no HTTP route, no CLI. `userId` must be the trusted session user.
 *
 * Authorization (fail closed, re-checked inside the read snapshot by role rank):
 *  - CMS enabled + dataset export capability (any live reader or above).
 *  - `published` perspective, no private data: reader or above.
 *  - `previewDrafts` / `raw` (drafts): editor or above. Drafts are unreviewed work product.
 *  - `includePrivate: true`: dataset admin only. Private fields hold consent evidence, reviewer
 *    identities and provenance; a bulk export copies them out of the app where no later role or
 *    revocation check can apply, so it needs the role that can already manage grants.
 *
 * Unlike `queryCmsDataset`, the role floor is the ONLY gate beyond the sponsor's `cms.read`
 * entitlement: a lapsed authoring subscription does not block exporting (migration plan: reads
 * and exports survive downgrade, so customers can always take their data out).
 *
 * Audit: every successful export writes one organization-bound `AuditLog` row in the same
 * transaction (existing `cms.draft.save.v1` pattern, no new model): counts, sha256 and flags,
 * never document content. If that insert fails the export fails. Denied/failed attempts are
 * not logged (no existing pattern for pre-authorization events); that is a documented gap.
 */
import { isUuid } from "@/lib/site-identity";
import { resolveDatasetCmsCapabilities } from "../dataset-access";
import { CmsDocumentError, withCmsReadTransaction } from "../documents";
import type { CmsQueryDocument, CmsQueryPerspective } from "../query/groq";
import {
  CmsNdjsonError, resolveNdjsonLimits, serializeNdjson,
  type NdjsonErrorCode, type NdjsonLimits, type NdjsonManifest
} from "./ndjson";

export type ExportCmsDatasetInput = {
  /** Trusted authenticated session ID, never a request-supplied principal. */
  userId: string;
  datasetId: string;
  /** Default "published". */
  perspective?: CmsQueryPerspective;
  /** Default false; only the boolean `true` enables it. Requires dataset admin. */
  includePrivate?: boolean;
  /** Server-side callers only; never forward client input. */
  limits?: Partial<NdjsonLimits>;
};
export type ExportCmsDatasetResult = { ndjson: Buffer; manifest: NdjsonManifest };

export const CMS_EXPORT_AUDIT_ACTION = "cms.export.ndjson.v1";
/** Total decoded payload bytes held for one export; independent of the document count cap. */
const MAX_LOAD_BYTES = 64 * 1024 * 1024;
const REVISION_CHUNK = 100;
const RANK = { reader: 0, editor: 1, admin: 3 } as const;

const deny = (): never => { throw new CmsNdjsonError("denied"); };

export async function exportCmsDatasetNdjson(input: ExportCmsDatasetInput): Promise<ExportCmsDatasetResult> {
  const { userId, datasetId } = input ?? ({} as ExportCmsDatasetInput);
  if (typeof window !== "undefined" || process.env.JONGO_CMS_ENABLED !== "true" ||
      typeof userId !== "string" || !isUuid(userId) || typeof datasetId !== "string" || !isUuid(datasetId)) return deny();
  const perspective = input.perspective ?? "published";
  if (perspective !== "published" && perspective !== "previewDrafts" && perspective !== "raw") throw new CmsNdjsonError("invalid_perspective");
  if (input.includePrivate !== undefined && typeof input.includePrivate !== "boolean") throw new CmsNdjsonError("invalid_options");
  const includePrivate = input.includePrivate === true;
  // Bad options fail before any DB access.
  const limits = resolveNdjsonLimits(input.limits);

  const capabilities = await resolveDatasetCmsCapabilities(userId, datasetId);
  if (!capabilities.canExport || capabilities.datasetId !== datasetId) return deny();
  const minimumRank = includePrivate ? RANK.admin : perspective === "published" ? RANK.reader : RANK.editor;

  type Outcome = ExportCmsDatasetResult | { error: NdjsonErrorCode };
  let outcome: Outcome;
  try {
    // The repository wrapper rewrites thrown errors, so expected failures are returned as markers.
    outcome = await withCmsReadTransaction({ userId, datasetId }, minimumRank, async (tx, policy): Promise<Outcome> => {
      const rows = await tx.cmsDocument.findMany({
        where: { datasetId, archivedAt: null, currentRevisionId: { not: null },
          ...(perspective === "published" ? { variant: "published" } : {}) },
        select: { id: true, datasetId: true, nativeId: true, type: true, currentRevisionId: true, createdAt: true, updatedAt: true },
        orderBy: { id: "asc" }, take: limits.maxDocuments + 1
      });
      // Never silently truncate: a partial backup that looks complete is worse than none.
      if (rows.length > limits.maxDocuments) return { error: "dataset_too_large" };
      const documents: CmsQueryDocument[] = [];
      let loaded = 0;
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
              typeof payload !== "object" || payload === null || Array.isArray(payload)) return { error: "unavailable" };
          loaded += Buffer.byteLength(JSON.stringify(payload), "utf8");
          if (loaded > MAX_LOAD_BYTES) return { error: "dataset_too_large" };
          const body = payload as Record<string, unknown>;
          documents.push({
            ...body,
            _id: row.nativeId, _type: row.type,
            _rev: typeof body._rev === "string" && body._rev ? body._rev : revision.nativeRev,
            _createdAt: typeof body._createdAt === "string" ? body._createdAt : new Date(row.createdAt).toISOString(),
            _updatedAt: typeof body._updatedAt === "string" ? body._updatedAt : new Date(row.updatedAt).toISOString()
          });
        }
      }

      let result: { bytes: Buffer; manifest: NdjsonManifest };
      try {
        result = serializeNdjson(documents, { exportedAt: new Date().toISOString(), perspective, includePrivate, limits });
      } catch (error) {
        if (error instanceof CmsNdjsonError) return { error: error.code };
        throw error;
      }
      const { manifest } = result;
      await tx.auditLog.create({ data: {
        organizationId: policy.organizationId, actorId: userId, action: CMS_EXPORT_AUDIT_ACTION,
        resourceType: "cms_dataset", resourceId: datasetId,
        details: {
          datasetId, perspective, includePrivate, documentCount: manifest.documentCount, byteLength: manifest.byteLength,
          sha256: manifest.sha256, omitted: manifest.omitted, redactedSecretKeyCount: manifest.redactedSecretKeyCount
        }
      } });
      return { ndjson: result.bytes, manifest };
    });
  } catch (error) {
    // Raw DB/SQL errors are never surfaced.
    throw new CmsNdjsonError(error instanceof CmsDocumentError && error.code === "denied" ? "denied" : "unavailable");
  }
  if ("error" in outcome) throw new CmsNdjsonError(outcome.error);
  return outcome;
}
