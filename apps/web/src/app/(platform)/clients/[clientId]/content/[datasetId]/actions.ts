import { auth } from "@/lib/auth.config";
import { resolveDatasetCmsCapabilities } from "@/lib/cms/dataset-access";
import { CmsDocumentError, getCmsDocument, saveCmsDraftForm } from "@/lib/cms/documents";
import { getDb } from "@/lib/db";
import { finding, inspectJson, isObject } from "@/lib/cms/validation";
import { isUuid } from "@/lib/site-identity";
import type { DraftSaveRequest, DraftSaveResult } from "@/components/cms/DraftEditor";
import { createMarketingRelease, unpublishMarketing } from "@/lib/cms/marketing-publication";
import { mintMarketingDeliveryCredential, revokeMarketingDeliveryCredential } from "@/lib/cms/deliverycredentials";

const MARKETING_TYPES = new Set(["agencyWork", "partnerStories", "article"]);
type MarketingTarget = { clientId: string; datasetId: string };
export type MarketingAdminResult =
  | { status: "ok"; publicationRevision?: number; documentCount?: number; token?: string; credentialId?: string }
  | { status: "invalid" | "denied" | "conflict" | "unavailable" };
type PublishRequest = { revisionIds: string[]; expectedRevision: number };
type RevokeRequest = { credentialId: string };

type Target = {
  clientId: string; datasetId: string;
  envelope: { _id: string; _type: string; _rev: string; _createdAt: string; _updatedAt: string };
};

/** Server-only factory, NOT a remotely callable action accepting an envelope.
 * Next encrypts the captured server-selected target in the inline action closure.
 * Identity and capabilities are deliberately not captured: every call reauthenticates.
 */
export function createDraftSaveAction(target: Target) {
  return async function saveDraft(request: DraftSaveRequest): Promise<DraftSaveResult> {
    "use server";
    return persistDraft(target, request);
  };
}

async function persistDraft(target: Target, request: unknown): Promise<DraftSaveResult> {
  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (typeof userId !== "string" || !isUuid(userId) ||
        process.env.JONGO_CMS_ENABLED !== "true" || process.env.JONGO_CMS_WRITES_ENABLED !== "true") return { status: "denied" };
    if (!isUuid(target.clientId) || !isUuid(target.datasetId)) return { status: "denied" };
    // Strict bounded transport. No principal, source envelope, caps, lock version,
    // arbitrary payload or publication action is accepted from the browser.
    if (!isObject(request) || inspectJson(request).length ||
        Object.keys(request).sort().join(",") !== "documentId,expectedNativeRev,mutationId,serializedForm" ||
        (request.documentId !== null && (typeof request.documentId !== "string" || !isUuid(request.documentId))) ||
        (request.expectedNativeRev !== null && (typeof request.expectedNativeRev !== "string" ||
          !request.expectedNativeRev.length || request.expectedNativeRev.length > 512 || /[\u0000-\u001f\u007f]/.test(request.expectedNativeRev))) ||
        typeof request.mutationId !== "string" || !isUuid(request.mutationId) ||
        typeof request.serializedForm !== "string" || Buffer.byteLength(request.serializedForm, "utf8") > 512 * 1024 ||
        (request.documentId === null) !== (request.expectedNativeRev === null)) return { status: "invalid" };
    const caps = await resolveDatasetCmsCapabilities(userId, target.datasetId);
    if (caps.scope !== "dataset" || caps.datasetId !== target.datasetId || caps.organizationId !== target.clientId ||
        !caps.canRead || !caps.canEdit) return { status: "denied" };
    // Route-client binding is verified BEFORE any document query.
    if (request.documentId !== null) {
      const current = await getCmsDocument({ userId, datasetId: target.datasetId, documentId: request.documentId });
      if (!current || !current.draft || current.document.datasetId !== target.datasetId ||
          current.document.nativeId !== target.envelope._id || current.document.type !== target.envelope._type) return { status: "denied" };
    }
    // Do not parse against today's registry here: the locked service checks an
    // exact raw-transport receipt first, then validates NEW mutations only.
    const saved = await saveCmsDraftForm({ userId, datasetId: target.datasetId,
      ...(request.documentId === null ? {} : { documentId: request.documentId }),
      sourceId: target.envelope._id, envelope: target.envelope, serializedForm: request.serializedForm, mutationId: request.mutationId,
      // Untrusted CAS precondition only, never payload _rev or authorization.
      // Passing the original token also permits exact lost-response receipt replay.
      expectedNativeRev: request.expectedNativeRev });
    return { status: "saved", documentId: saved.documentId, nativeRev: saved.nativeRev };
  } catch (error) {
    if (error instanceof CmsDocumentError && error.code === "invalid") return {
      status: "invalid", findings: [finding("$", "validation", "Invalid field value; check the registered schema requirements.")]
    };
    return { status: error instanceof CmsDocumentError ? error.code : "unavailable" };
  }
}

/** Server-bound dataset actions. Browser input is limited to revision IDs,
 * pointer CAS values and a credential ID; actor, permission and scope stay server-side. */
export function createMarketingAdminActions(target: MarketingTarget) {
  return {
    publish: async (request: PublishRequest): Promise<MarketingAdminResult> => {
      "use server";
      return publishMarketing(target, request);
    },
    unpublish: async (request: { expectedRevision: number }): Promise<MarketingAdminResult> => {
      "use server";
      return unpublishMarketingAction(target, request);
    },
    mint: async (): Promise<MarketingAdminResult> => {
      "use server";
      return mintCredential(target);
    },
    revoke: async (request: RevokeRequest): Promise<MarketingAdminResult> => {
      "use server";
      return revokeCredential(target, request);
    }
  };
}

async function freshMarketingActor(target: MarketingTarget, permission: "publish" | "manage") {
  const session = await auth();
  const userId = session?.user?.id;
  if (typeof userId !== "string" || !isUuid(userId) || process.env.JONGO_CMS_ENABLED !== "true" ||
      process.env.JONGO_CMS_WRITES_ENABLED !== "true" || !isUuid(target.clientId) || !isUuid(target.datasetId)) return null;
  const caps = await resolveDatasetCmsCapabilities(userId, target.datasetId);
  if (caps.scope !== "dataset" || caps.datasetId !== target.datasetId || caps.organizationId !== target.clientId ||
      !caps.canRead || (permission === "publish" ? !caps.canPublish : !caps.canManageDataset)) return null;
  return userId;
}

function safeFailure(error: unknown): MarketingAdminResult {
  return { status: error instanceof CmsDocumentError ? error.code : "unavailable" };
}

async function publishMarketing(target: MarketingTarget, request: unknown): Promise<MarketingAdminResult> {
  try {
    if (!isObject(request) || inspectJson(request).length || Object.keys(request).sort().join(",") !== "expectedRevision,revisionIds" ||
        !Array.isArray(request.revisionIds) || request.revisionIds.length < 1 || request.revisionIds.length > 100 ||
        request.revisionIds.some(id => typeof id !== "string" || !isUuid(id)) ||
        new Set(request.revisionIds).size !== request.revisionIds.length ||
        typeof request.expectedRevision !== "number" || !Number.isInteger(request.expectedRevision) ||
        request.expectedRevision < 0 || request.expectedRevision >= 2147483647) return { status: "invalid" };
    const userId = await freshMarketingActor(target, "publish");
    if (!userId) return { status: "denied" };
    // Check the selected rows against this route's dataset and current *draft*
    // pointers before the publication service performs its locked recheck.
    const db = await getDb();
    if (!db) return { status: "unavailable" };
    const selected = request.revisionIds as string[];
    const rows = await db.cmsRevision.findMany({ where: { datasetId: target.datasetId, id: { in: selected } }, take: 100,
      select: { id: true, datasetId: true, documentId: true,
        document: { select: { id: true, datasetId: true, currentRevisionId: true, archivedAt: true, type: true, variant: true } } } });
    if (rows.length !== selected.length || rows.some((row: any) => !row || !selected.includes(row.id) ||
        row.datasetId !== target.datasetId || !row.document || row.document.datasetId !== target.datasetId ||
        row.document.id !== row.documentId || row.document.currentRevisionId !== row.id || row.document.archivedAt !== null ||
        row.document.variant !== "draft" || !MARKETING_TYPES.has(row.document.type))) return { status: "invalid" };
    const publicOrigins = (process.env.CMS_PUBLIC_MEDIA_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean);
    const receipt = await createMarketingRelease(userId, target.datasetId, selected, request.expectedRevision, { publicOrigins });
    return { status: "ok", publicationRevision: receipt.publicationRevision, documentCount: receipt.documentCount };
  } catch (error) { return safeFailure(error); }
}

async function unpublishMarketingAction(target: MarketingTarget, request: unknown): Promise<MarketingAdminResult> {
  try {
    if (!isObject(request) || inspectJson(request).length || Object.keys(request).join(",") !== "expectedRevision" ||
        typeof request.expectedRevision !== "number" || !Number.isInteger(request.expectedRevision) ||
        request.expectedRevision < 1 || request.expectedRevision >= 2147483647) return { status: "invalid" };
    const userId = await freshMarketingActor(target, "publish");
    if (!userId) return { status: "denied" };
    const receipt = await unpublishMarketing(userId, target.datasetId, request.expectedRevision);
    return { status: "ok", publicationRevision: receipt.publicationRevision };
  } catch (error) { return safeFailure(error); }
}

async function mintCredential(target: MarketingTarget): Promise<MarketingAdminResult> {
  try {
    const userId = await freshMarketingActor(target, "manage");
    if (!userId) return { status: "denied" };
    const credential = await mintMarketingDeliveryCredential(userId, target.datasetId);
    // The raw token is returned only in this one action response; it is never persisted or logged.
    return { status: "ok", token: credential.token, credentialId: credential.id };
  } catch (error) { return safeFailure(error); }
}

async function revokeCredential(target: MarketingTarget, request: unknown): Promise<MarketingAdminResult> {
  try {
    if (!isObject(request) || inspectJson(request).length || Object.keys(request).join(",") !== "credentialId" ||
        typeof request.credentialId !== "string" || !isUuid(request.credentialId)) return { status: "invalid" };
    const userId = await freshMarketingActor(target, "manage");
    if (!userId) return { status: "denied" };
    await revokeMarketingDeliveryCredential(userId, target.datasetId, request.credentialId);
    return { status: "ok" };
  } catch (error) { return safeFailure(error); }
}