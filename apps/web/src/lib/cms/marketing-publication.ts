import { randomUUID } from "node:crypto";
import { executeCmsWriteTransaction, CmsDocumentError } from "./documents";
import { isUuid } from "@/lib/site-identity";
import { sourceIdentity, validateDocument } from "./schema";
import { cmsSchemaRegistry } from "./schemas";
import { mapApprovedRelease, type PublicMarketingDocument } from "./marketing-contracts";
import { marketingChecksum, parseMarketingSnapshot, validateMarketingDocuments } from "./marketing-snapshot";
import { assertMediaOrigins, loadApprovedMedia } from "./media";
import { inspectJson, isObject, type JsonValue, type ReferenceTarget } from "./validation";

if (typeof window !== "undefined") throw new Error("Marketing publication is server-only.");

type Tx = Parameters<Parameters<typeof executeCmsWriteTransaction>[2]>[0];
const MARKETING_TYPES: readonly string[] = ["agencyWork", "partnerStories", "article"];
const MAX_SNAPSHOT_BYTES = 1048576;
const invalid = (): never => { throw new CmsDocumentError("invalid"); };
const conflict = (): never => { throw new CmsDocumentError("conflict"); };

export type MarketingReleaseReceipt = {
  datasetId: string; releaseId: string; sequence: number; publicationRevision: number;
  checksum: string; documentCount: number;
};
export type MarketingPointerReceipt = { datasetId: string; releaseId: string; publicationRevision: number };

function assertRevision(value: unknown, minimum: number): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value >= 2147483647) invalid();
}
function serverOrigins(options: { publicOrigins: readonly string[] } | undefined): readonly string[] {
  const raw: unknown = options?.publicOrigins;
  const list: readonly string[] = Object.freeze(Array.isArray(raw) ? [...raw] : []);
  try { assertMediaOrigins(list); } catch { return invalid(); }
  return list;
}
const refId = (value: unknown): string | null =>
  isObject(value) && value._type === "reference" && typeof value._ref === "string" ? value._ref : null;

/** Exact image positions the public projection consumes; nothing else is media. */
export function marketingAssetRefs(payload: Record<string, unknown>): string[] {
  const refs: (string | null)[] = [];
  const image = (value: unknown) => { if (isObject(value)) refs.push(refId(value.asset)); };
  if (payload._type === "agencyWork") {
    refs.push(refId(payload.cardAsset));
    if (Array.isArray(payload.gallery)) payload.gallery.forEach(image);
  } else if (payload._type === "partnerStories") {
    image(payload.portrait); refs.push(refId(payload.logo));
  } else if (payload._type === "article") {
    image(payload.cover);
    if (Array.isArray(payload.body)) payload.body.forEach(node => { if (isObject(node) && node._type === "image") image(node); });
  }
  return refs.filter((id): id is string => id !== null);
}
function collectRefs(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) value.forEach(item => collectRefs(item, into));
  else if (isObject(value)) {
    const id = refId(value);
    if (id !== null) into.add(id);
    Object.values(value).forEach(item => collectRefs(item, into));
  }
}
function publicImageUrls(documents: readonly PublicMarketingDocument[]): string[] {
  return documents.flatMap(doc => doc.kind === "workCaseStudy" ? [doc.cardImage.src, ...doc.gallery.map(item => item.src)]
    : doc.kind === "testimonial" ? [doc.portrait, ...(doc.logo ? [doc.logo.src] : [])]
    : [doc.cover.src, ...doc.body.flatMap(block => block._type === "image" ? [block.src] : [])]);
}

/** Every pointer change increments revision; absent row is revision 0. */
async function movePointer(tx: Tx, datasetId: string, expected: number, exists: boolean,
  data: { releaseId: string | null; status: "active" | "revoked"; actorId: string }): Promise<number> {
  const revision = expected + 1;
  if (!exists) {
    if (expected !== 0) conflict();
    await tx.cmsMarketingPublication.create({ data: { datasetId, ...data, revision } });
    return revision;
  }
  const moved = await tx.cmsMarketingPublication.updateMany({ where: { datasetId, revision: expected }, data: { ...data, revision } });
  if (moved.count !== 1) conflict();
  return revision;
}

/** Internal service only; never an HTTP endpoint and never accepts DTOs, approval
 * booleans, resolvers or snapshot text. Caller order is the public order. */
export async function createMarketingRelease(actorId: string, datasetId: string, revisionIds: readonly string[],
  expectedPublicationRevision: number, options: { publicOrigins: readonly string[] }): Promise<MarketingReleaseReceipt> {
  if (!Array.isArray(revisionIds) || revisionIds.length === 0 || revisionIds.length > 100 ||
    revisionIds.some(id => typeof id !== "string" || !isUuid(id)) || new Set(revisionIds).size !== revisionIds.length) invalid();
  assertRevision(expectedPublicationRevision, 0);
  const selected = [...revisionIds];
  const publicOrigins = serverOrigins(options);
  return executeCmsWriteTransaction({ userId: actorId, datasetId }, "publish", async (tx, policy) => {
    const publication = await tx.cmsMarketingPublication.findUnique({ where: { datasetId }, select: { revision: true } });
    if ((publication?.revision ?? 0) !== expectedPublicationRevision) conflict();
    const rows = await tx.cmsRevision.findMany({ where: { datasetId, id: { in: selected } }, take: 100,
      select: { id: true, datasetId: true, documentId: true, schemaVersion: true, payload: true,
        document: { select: { id: true, datasetId: true, currentRevisionId: true, archivedAt: true,
          type: true, nativeId: true, logicalId: true, variant: true } } } });
    if (rows.length !== selected.length) invalid();
    const byId = new Map<string, any>(rows.map(row => [row.id, row]));
    const releaseId = randomUUID();
    const entries = selected.map(revisionId => {
      const revision = byId.get(revisionId);
      const document = revision?.document;
      if (!revision || revision.id !== revisionId || revision.datasetId !== datasetId || !document ||
        document.datasetId !== datasetId || document.id !== revision.documentId || document.archivedAt !== null ||
        document.currentRevisionId !== revision.id || !MARKETING_TYPES.includes(document.type) ||
        cmsSchemaRegistry.get(document.type)?.schemaVersion !== revision.schemaVersion || inspectJson(revision.payload).length) return invalid();
      const identity = sourceIdentity(document.nativeId);
      if (!identity.logicalId || identity.logicalId !== document.logicalId || identity.variant !== document.variant) invalid();
      const stored = validateDocument(revision.payload, cmsSchemaRegistry, { mode: "draft" });
      if (!stored.valid || !stored.value || stored.value._id !== document.nativeId || stored.value._type !== document.type) invalid();
      // Explicit promotion on a detached copy; the stored draft revision is never rewritten.
      const payload = JSON.parse(JSON.stringify(revision.payload)) as Record<string, JsonValue>;
      payload._id = identity.logicalId;
      return { revisionId: revision.id as string, documentId: document.id as string, schemaVersion: revision.schemaVersion as number, payload };
    });
    const assetIds = new Set<string>(), documentRefs = new Set<string>();
    for (const entry of entries) {
      marketingAssetRefs(entry.payload).forEach(id => assetIds.add(id));
      collectRefs(entry.payload, documentRefs);
    }
    assetIds.forEach(id => documentRefs.delete(id));
    if (assetIds.size > 200 || documentRefs.size > 200) invalid();
    // Missing, pending or revoked media refuses the whole release.
    const media = await loadApprovedMedia(tx, datasetId, [...assetIds], publicOrigins);
    const targets = documentRefs.size ? await tx.cmsDocument.findMany({ where: { datasetId, archivedAt: null,
      logicalId: { in: [...documentRefs] } }, select: { datasetId: true, logicalId: true, type: true }, take: 401 }) : [];
    const targetTypes = new Map<string, Set<string>>();
    for (const target of targets) if (target.datasetId === datasetId && documentRefs.has(target.logicalId)) {
      targetTypes.set(target.logicalId, (targetTypes.get(target.logicalId) ?? new Set<string>()).add(target.type));
    }
    const records = new Map<string, ReferenceTarget>(media.references);
    // Draft-prefixed or ambiguous targets stay unresolved, so strong references refuse.
    for (const [logicalId, types] of targetTypes) if (types.size === 1 && !records.has(logicalId)) records.set(logicalId, { _type: [...types][0] });
    const documents: PublicMarketingDocument[] = entries.map(entry => {
      const checked = validateDocument(entry.payload, cmsSchemaRegistry, { mode: "publish", records });
      if (!checked.valid || !checked.canPublish || !checked.value) invalid();
      try {
        return mapApprovedRelease({
          release: { releaseId, datasetId, documentId: entry.documentId, revisionId: entry.revisionId, schemaVersion: entry.schemaVersion },
          revision: { id: entry.revisionId, datasetId, documentId: entry.documentId, schemaVersion: entry.schemaVersion, payload: entry.payload },
          references: records
        }, media.resolveAsset);
      } catch { return invalid(); }
    });
    try { validateMarketingDocuments(documents); } catch { invalid(); }
    const snapshotText = JSON.stringify(documents);
    if (Buffer.byteLength(snapshotText, "utf8") > MAX_SNAPSHOT_BYTES) invalid();
    const checksum = marketingChecksum(snapshotText);
    const last = await tx.cmsMarketingRelease.findFirst({ where: { datasetId }, orderBy: { sequence: "desc" }, select: { sequence: true } });
    const sequence = (last?.sequence ?? 0) + 1;
    if (!Number.isSafeInteger(sequence) || sequence > 2147483647) conflict();
    await tx.cmsMarketingRelease.create({ data: { id: releaseId, datasetId, sequence, version: 1,
      payload: { documents: JSON.parse(snapshotText) }, snapshotText, payloadChecksum: checksum, actorId } });
    const publicationRevision = await movePointer(tx, datasetId, expectedPublicationRevision, !!publication,
      { releaseId, status: "active", actorId });
    await tx.cmsContentOutbox.create({ data: { datasetId, releaseId, publicationRevision, eventType: "release_publish", actorId,
      payload: { schemaVersion: 1, eventType: "release_publish", datasetId, releaseId, publicationRevision, checksum } } });
    await tx.auditLog.create({ data: { organizationId: policy.organizationId, actorId, action: "cms.marketing.release.publish",
      resourceType: "cms_dataset", resourceId: datasetId, details: { releaseId, sequence, publicationRevision, checksum,
        documentCount: documents.length, revisionIds: selected } } });
    return { datasetId, releaseId, sequence, publicationRevision, checksum, documentCount: documents.length };
  });
}

/** Whole-snapshot takedown: clears the pointer only; retained releases are never deleted. */
export async function unpublishMarketing(actorId: string, datasetId: string, expectedRevision: number): Promise<MarketingPointerReceipt> {
  assertRevision(expectedRevision, 1);
  return executeCmsWriteTransaction({ userId: actorId, datasetId }, "publish", async (tx, policy) => {
    const publication = await tx.cmsMarketingPublication.findUnique({ where: { datasetId }, select: { revision: true, status: true, releaseId: true } });
    if (!publication || publication.revision !== expectedRevision || publication.status !== "active" ||
      typeof publication.releaseId !== "string" || !isUuid(publication.releaseId)) conflict();
    const releaseId: string = publication.releaseId;
    const publicationRevision = await movePointer(tx, datasetId, expectedRevision, true, { releaseId: null, status: "revoked", actorId });
    await tx.cmsContentOutbox.create({ data: { datasetId, releaseId, publicationRevision, eventType: "release_unpublish", actorId,
      payload: { schemaVersion: 1, eventType: "release_unpublish", datasetId, releaseId, publicationRevision } } });
    await tx.auditLog.create({ data: { organizationId: policy.organizationId, actorId, action: "cms.marketing.release.unpublish",
      resourceType: "cms_dataset", resourceId: datasetId, details: { releaseId, publicationRevision } } });
    return { datasetId, releaseId, publicationRevision };
  });
}

/** Re-points to a retained same-dataset release after re-verifying its snapshot
 * and that every image it serves is still approved (revoked media never returns). */
export async function rollbackMarketingRelease(actorId: string, datasetId: string, releaseId: string,
  expectedRevision: number): Promise<MarketingPointerReceipt> {
  if (typeof releaseId !== "string" || !isUuid(releaseId)) invalid();
  assertRevision(expectedRevision, 1);
  return executeCmsWriteTransaction({ userId: actorId, datasetId }, "publish", async (tx, policy) => {
    const publication = await tx.cmsMarketingPublication.findUnique({ where: { datasetId }, select: { revision: true, status: true, releaseId: true } });
    if (!publication || publication.revision !== expectedRevision ||
      (publication.status === "active" && publication.releaseId === releaseId)) conflict();
    const release = await tx.cmsMarketingRelease.findFirst({ where: { datasetId, id: releaseId },
      select: { id: true, datasetId: true, version: true, snapshotText: true, payloadChecksum: true } });
    if (!release || release.id !== releaseId || release.datasetId !== datasetId || release.version !== 1) invalid();
    let documents: PublicMarketingDocument[] = [];
    try { documents = parseMarketingSnapshot(release.snapshotText, release.payloadChecksum); } catch { invalid(); }
    if (!documents.length) invalid();
    const urls = [...new Set(publicImageUrls(documents))];
    if (urls.length > 200) invalid();
    const approved = urls.length ? await tx.cmsApprovedMedia.findMany({ where: { datasetId, status: "approved", url: { in: urls } },
      select: { datasetId: true, status: true, url: true }, take: 201 }) : [];
    const live = new Set(approved.filter(row => row.datasetId === datasetId && row.status === "approved").map(row => row.url));
    if (urls.some(url => !live.has(url))) invalid();
    const publicationRevision = await movePointer(tx, datasetId, expectedRevision, true, { releaseId, status: "active", actorId });
    await tx.cmsContentOutbox.create({ data: { datasetId, releaseId, publicationRevision, eventType: "release_publish", actorId,
      payload: { schemaVersion: 1, eventType: "release_publish", datasetId, releaseId, publicationRevision,
        checksum: release.payloadChecksum, rollback: true } } });
    await tx.auditLog.create({ data: { organizationId: policy.organizationId, actorId, action: "cms.marketing.release.rollback",
      resourceType: "cms_dataset", resourceId: datasetId, details: { releaseId, publicationRevision, checksum: release.payloadChecksum } } });
    return { datasetId, releaseId, publicationRevision };
  });
}