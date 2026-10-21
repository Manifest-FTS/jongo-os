import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const mocks = vi.hoisted(() => ({ write: vi.fn(), execute: vi.fn() }));
vi.mock("./documents", () => ({
  CmsDocumentError: class extends Error { constructor(public code: string) { super(code); } },
  withCmsWriteTransaction: mocks.write, executeCmsWriteTransaction: mocks.execute
}));
import { createCmsMediaService as createService, isApprovedMediaUrl, loadApprovedMedia as loadMedia, MAX_MEDIA_BYTES,
  type PrismaCmsApprovedAsset, type CmsMediaStore } from "./media";
import { createIsolatedFileSystemMediaStore } from "./media-local-store";

const actor = "11111111-1111-4111-8111-111111111111";
const dataset = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";
let rows: PrismaCmsApprovedAsset[];
let tx: any;
let privateObjects: Map<string, Buffer>;
let publicObjects: Map<string, Buffer>;
let store: CmsMediaStore;
let roots: string[] = [];
const png = () => sharp({ create: { width: 8, height: 6, channels: 3, background: "red" } }).png().toBuffer();
const matches = (row: any, where: any) => Object.entries(where).every(([key, val]: [string, any]) =>
  val && typeof val === "object" && "in" in val ? val.in.includes(row[key]) : row[key] === val);
const origins = ["https://owned.example"] as const;
const cleanup = vi.fn(async () => true);
const createCmsMediaService = (s: CmsMediaStore) => createService(s, { publicOrigins: origins, cleanup });
const loadApprovedMedia = (t: any, d: string, ids: string[]) => loadMedia(t, d, ids, origins);
const stage = async () => createCmsMediaService(store).stageApprovedImage(actor, dataset, await png(), "image/png", { alt: "Approved image", caption: "Caption", nativeId: "original-image" });
const localRoot = async () => { const dir = await mkdtemp(join(tmpdir(), "jongo-media-test-")); roots.push(dir); return dir; };
beforeEach(() => {
  vi.resetAllMocks();
  cleanup.mockResolvedValue(true);
  rows = []; privateObjects = new Map(); publicObjects = new Map();
  tx = { cmsApprovedMedia: {
    create: vi.fn(async ({ data }) => { rows.push(structuredClone(data)); return data; }),
    findFirst: vi.fn(async ({ where }) => rows.find(row => matches(row, where)) ?? null),
    findMany: vi.fn(async ({ where }) => rows.filter(row => matches(row, where))),
    updateMany: vi.fn(async ({ where, data }) => { const row = rows.find(row => matches(row, where)); if (!row) return { count: 0 }; Object.assign(row, data); return { count: 1 }; })
  }, cmsMediaCleanupJob: { create: vi.fn(async () => ({ id: "44444444-4444-4444-8444-444444444444" })) },
    auditLog: { create: vi.fn(async () => ({})) } };
  mocks.write.mockImplementation(async (_scope, action) => action(tx, other));
  mocks.execute.mockImplementation(async (_scope, _permission, action) => action(tx, { organizationId: other }));
  store = {
    putPrivate: vi.fn(async (key, bytes) => { if (privateObjects.has(key)) throw new Error("immutable"); privateObjects.set(key, Buffer.from(bytes)); }),
    getPrivate: vi.fn(async key => Buffer.from(privateObjects.get(key)!)),
    promotePublic: vi.fn(async key => { publicObjects.set(key, Buffer.from(privateObjects.get(key)!)); }),
    getPublic: vi.fn(async key => Buffer.from(publicObjects.get(key)!)),
    publicUrl: vi.fn(key => `https://owned.example/assets/${key}`)
  };
});
afterEach(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); roots = []; });

describe("server-owned image approval", () => {
  it("stages real decoded WebP privately and records approval only after verified promotion", async () => {
    const receipt = await stage();
    expect(receipt.status).toBe("pending");
    const row = rows[0];
    expect(row.url).toBeNull(); expect(row.reviewerId).toBeNull();
    expect(publicObjects.size).toBe(0);
    const bytes = privateObjects.get(row.objectKey)!;
    expect(row.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(await sharp(bytes).metadata()).toMatchObject({ format: "webp", width: 8, height: 6 });
    expect(row).toMatchObject({ datasetId: dataset, byteSize: bytes.length, createdBy: actor });
    const approved = await createCmsMediaService(store).approveMedia(actor, dataset, receipt.id);
    expect(approved.status).toBe("approved");
    expect(rows[0]).toMatchObject({ status: "approved", reviewerId: actor, url: store.publicUrl(row.objectKey) });
    expect(mocks.execute).toHaveBeenCalledWith({ userId: actor, datasetId: dataset }, "manage", expect.any(Function));
    expect(tx.auditLog.create).toHaveBeenCalledTimes(2);
  });

  it.each(["image/png", "image/jpeg", "image/webp", "image/avif"])("decodes actual %s raster input", async mime => {
    const image = sharp({ create: { width: 4, height: 3, channels: 3, background: "blue" } });
    const format = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp", "image/avif": "avif" }[mime]!;
    const bytes = await image.toFormat(format as keyof sharp.FormatEnum).toBuffer();
    await expect(createCmsMediaService(store).stageApprovedImage(actor, dataset, bytes, mime, { alt: "Raster" })).resolves.toMatchObject({ status: "pending" });
  });

  it("strips real EXIF/XMP metadata through re-encoding", async () => {
    const bytes = await sharp(await png()).withMetadata().withExif({ IFD0: { Copyright: "PRIVATE GPS evidence" } }).png().toBuffer();
    expect((await sharp(bytes).metadata()).exif).toBeDefined();
    await createCmsMediaService(store).stageApprovedImage(actor, dataset, bytes, "image/png", { alt: "Clean" });
    const clean = await sharp(privateObjects.get(rows[0].objectKey)!).metadata();
    expect(clean.exif).toBeUndefined(); expect(clean.xmp).toBeUndefined(); expect(clean.icc).toBeUndefined();
  });

  it.each(["image/svg+xml", "image/gif", "image/heic", "text/html", "application/javascript", "application/octet-stream", "image/png; charset=utf-8"])("refuses %s", async type => {
    await expect(createCmsMediaService(store).stageApprovedImage(actor, dataset, await png(), type, { alt: "No" })).rejects.toThrow();
    expect(store.putPrivate).not.toHaveBeenCalled();
  });
  it.each([Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' width='5' height='5'/>"), Buffer.from("MZ executable"), Buffer.from([137,80,78,71,13,10,26,10])])("rejects forged/malformed PNG %s", async bytes => {
    await expect(createCmsMediaService(store).stageApprovedImage(actor, dataset, bytes, "image/png", { alt: "No" })).rejects.toThrow();
    expect(store.putPrivate).not.toHaveBeenCalled();
  });
  it("rejects mismatched MIME, oversized and truncated bytes", async () => {
    for (const [bytes, mime] of [[await png(), "image/jpeg"], [Buffer.alloc(MAX_MEDIA_BYTES + 1), "image/png"], [(await png()).subarray(0, 45), "image/png"]] as const) {
      await expect(createCmsMediaService(store).stageApprovedImage(actor, dataset, bytes, mime, { alt: "No" })).rejects.toThrow();
    }
    expect(store.putPrivate).not.toHaveBeenCalled();
  });
  it.each([{ alt: "" }, { alt: "<script>" }, { alt: "ok", nativeId: "drafts.asset" }])("refuses unsafe metadata %s", async metadata => {
    await expect(createCmsMediaService(store).stageApprovedImage(actor, dataset, await png(), "image/png", metadata)).rejects.toThrow();
    expect(store.putPrivate).not.toHaveBeenCalled();
  });
  it("does not decode/store for denied actors and rechecks authorization before persistence", async () => {
    mocks.write.mockRejectedValueOnce(new Error("denied"));
    await expect(stage()).rejects.toThrow(); expect(store.putPrivate).not.toHaveBeenCalled();
    mocks.write.mockImplementationOnce(async (_scope, cb) => cb(tx, other)).mockRejectedValueOnce(new Error("revoked"));
    await expect(stage()).rejects.toThrow(); expect(rows).toHaveLength(0);
  });
  it("requires fresh manage authority and never promotes for denied approval", async () => {
    const receipt = await stage(); mocks.execute.mockRejectedValueOnce(new Error("denied"));
    await expect(createCmsMediaService(store).approveMedia(actor, dataset, receipt.id)).rejects.toThrow();
    expect(store.promotePublic).not.toHaveBeenCalled(); expect(rows[0].status).toBe("pending");
  });
  it.each(["private", "public"])("rejects tampered %s bytes before approval persistence", async visibility => {
    const receipt = await stage();
    if (visibility === "private") privateObjects.set(rows[0].objectKey, Buffer.from("tampered"));
    else store.getPublic = vi.fn(async () => Buffer.from("tampered"));
    await expect(createCmsMediaService(store).approveMedia(actor, dataset, receipt.id)).rejects.toThrow();
    expect(rows[0].status).toBe("pending"); expect(tx.cmsApprovedMedia.updateMany).not.toHaveBeenCalled();
  });
  it("fails closed on promotion failure, unsafe URL, wrong dataset and repeated approval", async () => {
    const receipt = await stage();
    await expect(createCmsMediaService(store).approveMedia(actor, other, receipt.id)).rejects.toThrow();
    store.publicUrl = () => "http://unapproved.example/file.webp";
    await expect(createCmsMediaService(store).approveMedia(actor, dataset, receipt.id)).rejects.toThrow();
    for (const url of [(key: string) => `/assets/${key}`, (key: string) => `https://evil.example/assets/${key}`, () => "https://owned.example/assets/other.webp"]) {
      store.publicUrl = url;
      await expect(createCmsMediaService(store).approveMedia(actor, dataset, receipt.id)).rejects.toThrow();
    }
    expect(store.promotePublic).not.toHaveBeenCalled();
    store.publicUrl = key => `https://owned.example/assets/${key}`;
    await createCmsMediaService(store).approveMedia(actor, dataset, receipt.id);
    await expect(createCmsMediaService(store).approveMedia(actor, dataset, receipt.id)).rejects.toThrow();
    await createCmsMediaService(store).revokeMedia(actor, dataset, receipt.id);
    await expect(loadApprovedMedia(tx, dataset, [receipt.nativeId])).rejects.toThrow();
  });
  it("commits revocation and durable cleanup intent before provider cleanup; never reports success on cleanup failure", async () => {
    const receipt = await stage();
    await createCmsMediaService(store).approveMedia(actor, dataset, receipt.id);
    cleanup.mockResolvedValueOnce(false);
    await expect(createCmsMediaService(store).revokeMedia(actor, dataset, receipt.id)).rejects.toMatchObject({ code: "unavailable" });
    expect(rows[0].status).toBe("revoked");
    expect(tx.cmsMediaCleanupJob.create).toHaveBeenCalledWith({ data: {
      datasetId: dataset, mediaId: receipt.id, objectKey: rows[0].objectKey, publicUrl: rows[0].url
    }, select: { id: true } });
    expect(cleanup).toHaveBeenCalledWith("44444444-4444-4444-8444-444444444444");
    await expect(createCmsMediaService(store).revokeMedia(actor, dataset, receipt.id)).rejects.toThrow();
  });
  it("rejects oversized dimensions and animated inputs, not just MIME headers", async () => {
    const wide = await sharp({ create: { width: 16385, height: 1, channels: 3, background: "red" } }).png().toBuffer();
    await expect(createCmsMediaService(store).stageApprovedImage(actor, dataset, wide, "image/png", { alt: "Wide" })).rejects.toThrow();
    const frames = Buffer.concat([Buffer.alloc(2 * 2 * 3, 0), Buffer.alloc(2 * 2 * 3, 255)]);
    const animation = await sharp(frames, { raw: { width: 2, height: 4, channels: 3, pageHeight: 2 } }).webp({ delay: [100, 100] }).toBuffer();
    expect((await sharp(animation, { animated: true }).metadata()).pages).toBe(2);
    await expect(createCmsMediaService(store).stageApprovedImage(actor, dataset, animation, "image/webp", { alt: "Animated" })).rejects.toThrow();
    expect(store.putPrivate).not.toHaveBeenCalled();
  });
  it("never persists approval after provider promotion failure", async () => {
    const receipt = await stage();
    store.promotePublic = vi.fn(async () => { throw new Error("provider unavailable"); });
    await expect(createCmsMediaService(store).approveMedia(actor, dataset, receipt.id)).rejects.toThrow();
    expect(rows[0].status).toBe("pending");
    expect(tx.cmsApprovedMedia.updateMany).not.toHaveBeenCalled();
  });
  it.each(["status", "sha256", "mimeType", "width", "height", "byteSize", "reviewerId", "approvedAt", "createdAt", "url"])("refuses invalid persisted %s even if a delegate returns it", async field => {
    const receipt = await stage();
    await createCmsMediaService(store).approveMedia(actor, dataset, receipt.id);
    const bad: Record<string, unknown> = { status: "revoked", sha256: "forged", mimeType: "image/svg+xml", width: Infinity,
      height: 1.5, byteSize: MAX_MEDIA_BYTES + 1, reviewerId: null, approvedAt: null, createdAt: new Date(NaN), url: "https://evil.example/raw.svg" };
    tx.cmsApprovedMedia.findMany.mockResolvedValue([{ ...rows[0], [field]: bad[field] }]);
    await expect(loadApprovedMedia(tx, dataset, [receipt.nativeId])).rejects.toThrow();
  });
  it("loads exact persisted same-dataset refs and projects public fields only", async () => {
    const receipt = await stage();
    await expect(loadApprovedMedia(tx, dataset, [receipt.nativeId])).rejects.toThrow();
    await createCmsMediaService(store).approveMedia(actor, dataset, receipt.id);
    const loaded = await loadApprovedMedia(tx, dataset, [receipt.nativeId]);
    const release: any = { datasetId: dataset };
    const image = loaded.resolveAsset({ _type: "reference", _ref: receipt.nativeId }, release);
    expect(image).toEqual({ url: rows[0].url, alt: "Approved image", caption: "Caption" });
    expect(loaded.resolveAsset({ _type: "reference", _ref: receipt.nativeId }, { ...release, datasetId: other })).toBeNull();
    expect(loaded.references.get(receipt.nativeId)).toEqual({ _type: "sanity.imageAsset" });
    await expect(loadApprovedMedia(tx, dataset, ["missing"])).rejects.toThrow();
    tx.cmsApprovedMedia.findMany.mockResolvedValue([{ ...rows[0], datasetId: other }]);
    await expect(loadApprovedMedia(tx, dataset, [receipt.nativeId])).rejects.toThrow();
  });
  it("re-checks persisted URLs against the current server origin allowlist", async () => {
    const receipt = await stage();
    await createCmsMediaService(store).approveMedia(actor, dataset, receipt.id);
    await expect(loadMedia(tx, dataset, [receipt.nativeId], ["https://cdn.example"])).rejects.toThrow();
    for (const bad of [[], ["http://owned.example"], ["https://owned.example/assets"], ["https://u:p@owned.example"], "https://owned.example"]) {
      await expect(loadMedia(tx, dataset, [receipt.nativeId], bad as any)).rejects.toThrow();
      expect(() => createService(store, { publicOrigins: bad as any })).toThrow();
    }
  });
  it.each(["javascript:alert(1)", "//evil/assets/x", "/assets/x", "/other/x", "https://user:pass@owned.example/assets/x",
    "https://owned.example/assets/../secret", "https://evil.example/assets/x", "https://owned.example/assets/x?v=1", "http://owned.example/assets/x"])("rejects unapproved URL %s", url => {
    expect(isApprovedMediaUrl(url, "x", origins)).toBe(false);
  });
  it("accepts only exact allowlisted origin + object key", () => {
    expect(isApprovedMediaUrl("https://owned.example/assets/x", "x", origins)).toBe(true);
    expect(isApprovedMediaUrl("https://OWNED.example/assets/x", "x", origins)).toBe(false);
  });
});

describe("isolated filesystem proof adapter", () => {
  it("uses a new private namespace, create-only writes and verified immutable promotion", async () => {
    const local = await createIsolatedFileSystemMediaStore({ approvedOrigin: "https://owned.example", publicBaseUrl: "https://owned.example/assets/", parentDirectory: await localRoot() });
    store = local.store;
    const receipt = await stage(); const row = rows[0];
    await expect(store.getPublic(row.objectKey)).rejects.toThrow();
    await expect(store.putPrivate(row.objectKey, await store.getPrivate(row.objectKey))).rejects.toThrow();
    await createCmsMediaService(store).approveMedia(actor, dataset, receipt.id);
    expect(await store.getPublic(row.objectKey)).toEqual(await store.getPrivate(row.objectKey));
    await expect(store.promotePublic(row.objectKey)).resolves.toBeUndefined();
    await expect(store.getPrivate("../escape")).rejects.toThrow();
    for (const key of [`${dataset}/../../${row.sha256}.webp`, `..\\${row.objectKey}`, `${"-".repeat(36)}/${"-".repeat(36)}/${row.sha256}.webp`, row.objectKey.toUpperCase()]) {
      await expect(store.getPrivate(key)).rejects.toThrow();
      expect(() => store.publicUrl(key)).toThrow();
    }
    await writeFile(join(local.root, "public", ...row.objectKey.split("/")), "tampered");
    await expect(store.promotePublic(row.objectKey)).rejects.toThrow();
  });
  it("requires an explicit absolute non-public root and test mode", async () => {
    const base = { approvedOrigin: "https://owned.example", publicBaseUrl: "https://owned.example/assets/" };
    await expect(createIsolatedFileSystemMediaStore(base as any)).rejects.toThrow();
    await expect(createIsolatedFileSystemMediaStore({ ...base, parentDirectory: "relative/media" })).rejects.toThrow();
    const parent = await localRoot();
    await expect(createIsolatedFileSystemMediaStore({ ...base, parentDirectory: join(parent, "missing") })).rejects.toThrow();
    vi.stubEnv("NODE_ENV", "development");
    try { await expect(createIsolatedFileSystemMediaStore({ ...base, parentDirectory: parent })).rejects.toThrow(); }
    finally { vi.unstubAllEnvs(); }
  });
  it("refuses non-HTTPS, arbitrary origins, credentials and non-assets prefixes", async () => {
    for (const url of ["http://owned.example/assets/", "https://other.example/assets/", "https://owned.example/not-assets/", "https://user:pass@owned.example/assets/"]) {
      await expect(createIsolatedFileSystemMediaStore({ approvedOrigin: "https://owned.example", publicBaseUrl: url, parentDirectory: tmpdir() })).rejects.toThrow();
    }
  });
});
