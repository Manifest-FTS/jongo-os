import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { CmsDocumentError, executeCmsWriteTransaction, withCmsWriteTransaction } from "./documents";
import { isUuid } from "@/lib/site-identity";
import type { ApprovedAssetResolver } from "./marketing-contracts";

if (typeof window !== "undefined") throw new Error("CMS media is server-only.");
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const mimeFormats: Readonly<Record<string, string>> = {
  "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp", "image/avif": "heif"
};
const invalid = (): never => { throw new CmsDocumentError("invalid"); };
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Trusted server composition only: never accept adapters/base URLs from requests.
 * Implementations MUST use immutable create-only objects and bounded reads.
 * No remote URL import, delete capability, credentials, or runtime importer.
 */
export interface CmsMediaStore {
  putPrivate(key: string, bytes: Buffer): Promise<void>;
  getPrivate(key: string): Promise<Buffer>;
  promotePublic(key: string): Promise<void>;
  getPublic(key: string): Promise<Buffer>;
  publicUrl(key: string): string;
}
export type MediaCleanupRunner = (cleanupJobId: string) => Promise<boolean>;
export type PrismaCmsApprovedAsset = {
  id: string; datasetId: string; nativeId: string; assetType: string; objectKey: string;
  url: string | null; sha256: string; mimeType: string; width: number; height: number;
  byteSize: number; alt: string; caption: string; status: "pending" | "approved" | "revoked";
  reviewerId: string | null; approvedAt: Date | null; createdBy: string; createdAt: Date;
};
const select = { id: true, datasetId: true, nativeId: true, assetType: true, objectKey: true,
  url: true, sha256: true, mimeType: true, width: true, height: true, byteSize: true,
  alt: true, caption: true, status: true, reviewerId: true, approvedAt: true, createdBy: true, createdAt: true } as const;

/** Server-configured exact HTTPS origins (no path/credentials); never request data. */
export function assertMediaOrigins(origins: unknown): asserts origins is readonly string[] {
  if (!Array.isArray(origins) || !origins.length || origins.length > 8 || origins.some(origin => {
    try {
      const parsed = new URL(origin);
      return typeof origin !== "string" || parsed.protocol !== "https:" || parsed.origin !== origin;
    } catch { return true; }
  })) throw new Error("Invalid approved media origins.");
}

/** Exact `https://<allowlisted origin>/assets/<objectKey>` only. Relative paths are
 * refused: releases are consumed by other sites where they would resolve elsewhere. */
export function isApprovedMediaUrl(url: unknown, key: string, origins: readonly string[]): url is string {
  if (typeof url !== "string" || url.length > 4096) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && origins.includes(parsed.origin) &&
      url === `${parsed.origin}/assets/${key}`;
  } catch { return false; }
}
function text(value: unknown, max: number, required = false): value is string {
  return typeof value === "string" && value.length <= max && (!required || !!value.trim()) &&
    !/[\u0000-\u001f\u007f<>\ud800-\udfff]/u.test(value);
}
function assertRow(row: PrismaCmsApprovedAsset, datasetId: string): void {
  if (!row || row.datasetId !== datasetId || !isUuid(row.id) || !isUuid(row.datasetId) || !isUuid(row.createdBy) ||
      !(row.createdAt instanceof Date) || !Number.isFinite(row.createdAt.getTime()) ||
      !text(row.nativeId, 1024, true) || row.nativeId.startsWith("drafts.") ||
      row.assetType !== "sanity.imageAsset" || !/^[0-9a-f]{64}$/.test(row.sha256) ||
      row.objectKey !== `${datasetId}/${row.id}/${row.sha256}.webp` || row.mimeType !== "image/webp" ||
      !Number.isInteger(row.width) || !Number.isInteger(row.height) || row.width < 1 || row.height < 1 ||
      row.width > 16384 || row.height > 16384 || row.width * row.height > MAX_PIXELS ||
      !Number.isInteger(row.byteSize) || row.byteSize < 1 || row.byteSize > MAX_MEDIA_BYTES ||
      !text(row.alt, 300, true) || !text(row.caption, 5000)) invalid();
}
async function verify(bytes: Buffer, row: PrismaCmsApprovedAsset): Promise<void> {
  if (!Buffer.isBuffer(bytes) || bytes.length !== row.byteSize || digest(bytes) !== row.sha256) invalid();
  const image = sharp(bytes, { failOn: "warning", limitInputPixels: MAX_PIXELS });
  const metadata = await image.metadata();
  if (metadata.format !== "webp" || metadata.width !== row.width || metadata.height !== row.height ||
      (metadata.pages ?? 1) !== 1 || metadata.exif || metadata.xmp || metadata.icc) invalid();
  // Full decode: metadata/header inspection alone is not verification.
  await image.raw().toBuffer();
}

/** No default adapter: missing production storage must never become mock success. */
export function createCmsMediaService(store: CmsMediaStore, options: { publicOrigins: readonly string[]; cleanup?: MediaCleanupRunner }) {
  const publicOrigins = Object.freeze([...(options?.publicOrigins ?? [])]);
  assertMediaOrigins(publicOrigins);
  return {
    async stageApprovedImage(actorId: string, datasetId: string, bytes: Buffer, contentType: string,
      metadata: { alt: string; caption?: string; nativeId?: string }) {
      await withCmsWriteTransaction({ userId: actorId, datasetId }, async () => undefined);
      try {
        if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_MEDIA_BYTES || typeof contentType !== "string" ||
            !Object.hasOwn(mimeFormats, contentType) || !text(metadata?.alt, 300, true) ||
            !text(metadata.caption ?? "", 5000)) invalid();
        const decoder = sharp(Buffer.from(bytes), { failOn: "warning", limitInputPixels: MAX_PIXELS, animated: true });
        const info = await decoder.metadata();
        if (info.format !== mimeFormats[contentType] || (contentType === "image/avif" && info.compression !== "av1") ||
            (info.pages ?? 1) !== 1 || !info.width || !info.height || info.width > 16384 || info.height > 16384 ||
            info.width * info.height > MAX_PIXELS) invalid();
        // No keepMetadata/withMetadata: strip EXIF/GPS, XMP and ICC.
        const output = await decoder.rotate().webp({ quality: 90 }).toBuffer({ resolveWithObject: true });
        if (output.data.length > MAX_MEDIA_BYTES) invalid();
        const id = randomUUID();
        const sha256 = digest(output.data);
        const nativeId = metadata.nativeId ?? `image-${id}`;
        const row = { id, datasetId, nativeId, assetType: "sanity.imageAsset", objectKey: `${datasetId}/${id}/${sha256}.webp`,
          sha256, mimeType: "image/webp", width: output.info.width, height: output.info.height,
          byteSize: output.data.length, alt: metadata.alt, caption: metadata.caption ?? "", status: "pending" as const,
          url: null, reviewerId: null, approvedAt: null, createdBy: actorId, createdAt: new Date() };
        assertRow(row, datasetId);
        await store.putPrivate(row.objectKey, output.data);
        await verify(await store.getPrivate(row.objectKey), row);
        return await withCmsWriteTransaction({ userId: actorId, datasetId }, async (tx, organizationId) => {
          await tx.cmsApprovedMedia.create({ data: row });
          await tx.auditLog.create({ data: { organizationId, actorId, action: "cms.media.stage",
            resourceType: "cms_media", resourceId: id, details: { datasetId, sha256 } } });
          return { id, datasetId, nativeId, status: "pending" as const };
        });
      } catch (error) {
        if (error instanceof CmsDocumentError) throw error;
        throw new CmsDocumentError("unavailable");
      }
    },
    async approveMedia(actorId: string, datasetId: string, id: string) {
      if (!isUuid(id)) invalid();
      // Manage requires fresh admin + publish capacity under dataset/policy locks.
      return executeCmsWriteTransaction({ userId: actorId, datasetId }, "manage", async (tx, policy) => {
        const row: PrismaCmsApprovedAsset | null = await tx.cmsApprovedMedia.findFirst({ where: { id, datasetId, status: "pending" }, select });
        if (!row) throw new CmsDocumentError("conflict");
        assertRow(row, datasetId);
        await verify(await store.getPrivate(row.objectKey), row);
        const url = store.publicUrl(row.objectKey);
        if (!isApprovedMediaUrl(url, row.objectKey, publicOrigins)) invalid();
        await store.promotePublic(row.objectKey);
        await verify(await store.getPublic(row.objectKey), row);
        const approvedAt = new Date();
        const result = await tx.cmsApprovedMedia.updateMany({ where: { id, datasetId, status: "pending", sha256: row.sha256 },
          data: { status: "approved", url, reviewerId: actorId, approvedAt } });
        if (result.count !== 1) throw new CmsDocumentError("conflict");
        await tx.auditLog.create({ data: { organizationId: policy.organizationId, actorId, action: "cms.media.approve",
          resourceType: "cms_media", resourceId: id, details: { datasetId, sha256: row.sha256 } } });
        return { id, datasetId, nativeId: row.nativeId, status: "approved" as const };
      });
    },
    async revokeMedia(actorId: string, datasetId: string, id: string) {
      if (!isUuid(id)) invalid();
      const cleanupJobId = await executeCmsWriteTransaction({ userId: actorId, datasetId }, "manage", async (tx, policy) => {
        const row: PrismaCmsApprovedAsset | null = await tx.cmsApprovedMedia.findFirst({ where: { id, datasetId, status: "approved" }, select });
        if (!row) throw new CmsDocumentError("conflict");
        assertRow(row, datasetId);
        if (!isApprovedMediaUrl(row.url, row.objectKey, publicOrigins)) invalid();
        const result = await tx.cmsApprovedMedia.updateMany({ where: { id, datasetId, status: "approved" }, data: { status: "revoked" } });
        if (result.count !== 1) throw new CmsDocumentError("conflict");
        const cleanup = await tx.cmsMediaCleanupJob.create({ data: {
          datasetId, mediaId: id, objectKey: row.objectKey, publicUrl: row.url
        }, select: { id: true } });
        if (!isUuid(cleanup?.id)) throw new CmsDocumentError("unavailable");
        await tx.auditLog.create({ data: { organizationId: policy.organizationId, actorId, action: "cms.media.revoke",
          resourceType: "cms_media", resourceId: id, details: { datasetId, cleanupJobId: cleanup.id } } });
        return cleanup.id as string;
      });
      // The DB revocation and durable cleanup intent are already committed. A
      // missing provider/CDN or a failed purge must remain an unavailable result.
      try {
        if (!options.cleanup || !(await options.cleanup(cleanupJobId))) throw new CmsDocumentError("unavailable");
      } catch {
        throw new CmsDocumentError("unavailable");
      }
      return { id, datasetId, status: "revoked" as const, cleanupComplete: true as const };
    }
  };
}

/** Internal publisher bridge: caller MUST hold executeCmsWriteTransaction locks.
 * Queries persisted rows, never a caller-provided approved map/boolean.
 * Projection exposes no object keys, hashes, reviewer identities or timestamps. */
export async function loadApprovedMedia(tx: { cmsApprovedMedia: { findMany(query: unknown): Promise<PrismaCmsApprovedAsset[]> } },
  datasetId: string, nativeIds: readonly string[], publicOrigins: readonly string[]): Promise<{ references: ReadonlyMap<string, { _type: string }>; resolveAsset: ApprovedAssetResolver }> {
  assertMediaOrigins(publicOrigins);
  if (!isUuid(datasetId) || !Array.isArray(nativeIds) || nativeIds.length > 200 || nativeIds.some(id => !text(id, 1024, true))) invalid();
  const requested = [...new Set(nativeIds)];
  const rows = await tx.cmsApprovedMedia.findMany({ where: { datasetId, nativeId: { in: requested }, status: "approved" }, select, take: 201 });
  const assets = new Map<string, { url: string; alt: string; caption: string }>();
  for (const row of rows) {
    assertRow(row, datasetId);
    if (row.status !== "approved" || !requested.includes(row.nativeId) || assets.has(row.nativeId) ||
        !isUuid(row.reviewerId ?? "") || !(row.approvedAt instanceof Date) || !Number.isFinite(row.approvedAt.getTime()) ||
        !(row.createdAt instanceof Date) || row.approvedAt < row.createdAt) invalid();
    const url = row.url;
    if (!isApprovedMediaUrl(url, row.objectKey, publicOrigins)) return invalid();
    assets.set(row.nativeId, { url, alt: row.alt, caption: row.caption });
  }
  if (assets.size !== requested.length) invalid();
  return { references: new Map([...assets.keys()].map(id => [id, { _type: "sanity.imageAsset" }])),
    resolveAsset: (reference, release) => release.datasetId === datasetId && reference._type === "reference"
      ? assets.get(reference._ref) ?? null : null };
}
