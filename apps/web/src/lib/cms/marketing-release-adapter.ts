import type { ApprovedReleaseEnvelope } from "./marketing-contracts";
import { getDeliveryDb } from "./delivery-db";
import { isUuid } from "@/lib/site-identity";
import { deliveryTokenHash, MarketingDeliveryError, parseMarketingSnapshot } from "./marketing-snapshot";

// Match the existing app-local runtime guard without introducing a dependency.
if (typeof window !== "undefined") throw new Error("Marketing release adapter is server-only.");

/** Dedicated authenticated snapshot read. No authoring delegates or subscription
 * lookup: a downgrade never discards an already-authorized immutable release. */
export async function readMarketingPublication(datasetId: string, authorization: string | null) {
  const tokenHash = deliveryTokenHash(authorization);
  if (!isUuid(datasetId)) throw new MarketingDeliveryError("not_found");
  try {
    const db = getDeliveryDb();
    return await db.$transaction(async (tx: any) => {
      const credential = await tx.cmsDeliveryCredential.findUnique({ where: { tokenHash }, select: {
        datasetId: true, type: true, revokedAt: true, expiresAt: true
      } });
      if (!credential || credential.type !== "marketing.read" || credential.datasetId !== datasetId ||
        credential.revokedAt !== null || (credential.expiresAt !== null && credential.expiresAt.getTime() <= Date.now())) {
        throw new MarketingDeliveryError("unauthorized");
      }
      const dataset = await tx.cmsDataset.findUnique({ where: { id: datasetId }, select: {
        id: true, archivedAt: true, organizationId: true, siteId: true,
        organization: { select: { id: true, deletedAt: true, owner: { select: { deletedAt: true } } } },
        site: { select: { id: true, organizationId: true, deletedAt: true } },
        activeMarketingPublication: { select: { datasetId: true, status: true, releaseId: true, release: { select: {
          id: true, datasetId: true, version: true, snapshotText: true, payloadChecksum: true
        } } } }
      } });
      if (!dataset || dataset.id !== datasetId || dataset.archivedAt !== null ||
        !dataset.organization || dataset.organization.id !== dataset.organizationId || dataset.organization.deletedAt !== null ||
        !dataset.organization.owner || dataset.organization.owner.deletedAt !== null ||
        (dataset.siteId !== null && (!dataset.site || dataset.site.id !== dataset.siteId ||
          dataset.site.organizationId !== dataset.organizationId || dataset.site.deletedAt !== null))) throw new MarketingDeliveryError("not_found");
      const publication = dataset.activeMarketingPublication;
      if (!publication || publication.datasetId !== datasetId || publication.status !== "active" || !publication.releaseId) throw new MarketingDeliveryError("not_found");
      const release = publication.release;
      if (!release || release.id !== publication.releaseId || !isUuid(release.id) || release.datasetId !== datasetId || release.version !== 1) throw new MarketingDeliveryError("unavailable");
      const documents = parseMarketingSnapshot(release.snapshotText, release.payloadChecksum);
      return { schemaVersion: 1 as const, datasetId, releaseId: release.id, checksum: release.payloadChecksum as string, documents };
    }, { isolationLevel: "RepeatableRead", maxWait: 3000, timeout: 10000 });
  } catch (error) {
    if (error instanceof MarketingDeliveryError) throw error;
    throw new MarketingDeliveryError("unavailable");
  }
}

/**
 * Deliberately unavailable. Future server implementation must authorize the
 * consumer, load its active authoritative public release and exact revision,
 * enforce audience/dataset/schema/approval/takedown/reference/media closure.
 * Never substitute getCmsDocument(), canPublish, a boolean, or source variant.
 * This legacy source-envelope API stays unavailable. Delivery uses only the
 * strict snapshot reader above; never reconstruct a source envelope from DTOs.
 */
export async function loadApprovedMarketingRelease(_selection: {
  consumerId: string; type: "agencyWork" | "partnerStories" | "article"; slug: string; locale: string;
}): Promise<ApprovedReleaseEnvelope> {
  throw new Error("Authoritative marketing release adapter is not implemented.");
}