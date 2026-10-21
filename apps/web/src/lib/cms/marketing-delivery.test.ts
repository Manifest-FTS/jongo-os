import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ db: vi.fn(), getDb: vi.fn(), jwt: vi.fn() }));
vi.mock("./delivery-db", () => ({ getDeliveryDb: mocks.db }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
vi.mock("next-auth/jwt", () => ({ getToken: mocks.jwt }));
import { readMarketingPublication } from "./marketing-release-adapter";
import { marketingChecksum, parseMarketingSnapshot } from "./marketing-snapshot";
import { deliveryTokenHash, mintMarketingDeliveryCredential, revokeMarketingDeliveryCredential } from "./deliverycredentials";
import { createMarketingRelease } from "./marketing-publication";
import { GET } from "@/app/api/content/v1/datasets/[datasetId]/marketing/route";
import { middleware } from "@/middleware";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const datasetId = id(1), releaseId = id(2), ownerId = id(3), orgId = id(4), revisionId = id(5), documentId = id(6);
const token = `jcms_${"a".repeat(43)}`, authorization = `Bearer ${token}`;
const publish = { publicOrigins: ["https://media.example"] };
// Synthetic public DTO only. No actual person/approval or production seed.
const article = () => ({ kind: "article", id: "article.synthetic", slug: "synthetic", title: "Synthetic",
  excerpt: "Test only", publishedAt: "2026-10-01T00:00:00Z", cover: { src: "/test.webp", alt: "Test", caption: "" },
  body: [{ _type: "block", _key: "b1", style: "normal", children: [{ _type: "span", _key: "s1", text: "Test", marks: [] }], markDefs: [] }] });
let tx: any, dataset: any, credential: any, release: any;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("JONGO_CMS_ENABLED", "true"); vi.stubEnv("JONGO_CMS_WRITES_ENABLED", "true");
  vi.stubEnv("NEXTAUTH_SECRET", "test-not-a-dev-bypass");
  const snapshotText = JSON.stringify([article()]);
  release = { id: releaseId, datasetId, version: 1, snapshotText, payloadChecksum: marketingChecksum(snapshotText) };
  credential = { datasetId, type: "marketing.read", revokedAt: null, expiresAt: null };
  dataset = { id: datasetId, archivedAt: null, organizationId: orgId, siteId: null, grants: [], site: null,
    organization: { id: orgId, ownerId, deletedAt: null, collaborators: [], owner: { id: ownerId, deletedAt: null,
      subscriptionPlanId: "core-sla", subscriptionStatus: "active", subscriptionCurrentPeriodEnd: new Date("2030-01-01T00:00:00Z") } },
    activeMarketingPublication: { datasetId, status: "active", releaseId, release } };
  const delegate = () => ({ findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]), create: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) });
  tx = { user: delegate(), cmsDataset: delegate(), cmsDeliveryCredential: delegate(), cmsMarketingPublication: delegate(),
    cmsMarketingRelease: delegate(), cmsContentOutbox: delegate(), cmsDocument: delegate(), cmsRevision: delegate(),
    cmsReference: delegate(), auditLog: delegate(), $executeRaw: vi.fn(), $queryRaw: vi.fn() };
  tx.user.findUnique.mockResolvedValue({ id: ownerId, deletedAt: null });
  tx.cmsDataset.findUnique.mockImplementation(async () => dataset);
  tx.cmsDeliveryCredential.findUnique.mockImplementation(async () => credential);
  tx.cmsMarketingPublication.findUnique.mockResolvedValue({ revision: 0 });
  tx.$transaction = vi.fn(async (action: any) => action(tx));
  mocks.db.mockReturnValue(tx); mocks.jwt.mockResolvedValue(null);
});
afterEach(() => vi.unstubAllEnvs());
const read = (auth: string | null = authorization) => readMarketingPublication(datasetId, auth);
const get = (auth: string | null = authorization, etag?: string) => GET(new Request("http://localhost/", { headers: {
  ...(auth === null ? {} : { authorization: auth }), ...(etag ? { "if-none-match": etag } : {})
} }), { params: Promise.resolve({ datasetId }) });

describe("strict marketing snapshot", () => {
  it("survives JSONB object-key reordering by hashing the retained exact text, not metadata", async () => {
    release.payload = { documents: [JSON.parse(JSON.stringify(article(), Object.keys(article()).reverse()))] };
    const result = await read();
    expect(Object.keys(result)).toEqual(["schemaVersion", "datasetId", "releaseId", "checksum", "documents"]);
    expect(result.documents).toEqual([article()]);
    expect(result.checksum).toBe(marketingChecksum(JSON.stringify(result.documents)));
    expect(tx.cmsDocument.findMany).not.toHaveBeenCalled(); expect(tx.cmsRevision.findMany).not.toHaveBeenCalled();
  });
  it.each(["privateEvidence", "_id", "source", "draft", "credentials"])("rejects unknown DTO key %s even with a valid checksum", async key => {
    release.snapshotText = JSON.stringify([{ ...article(), [key]: "PRIVATE" }]); release.payloadChecksum = marketingChecksum(release.snapshotText);
    await expect(read()).rejects.toMatchObject({ code: "unavailable" });
  });
  it.each([
    (doc: any) => { doc.id = "drafts.article.synthetic"; },
    (doc: any) => { doc.cover.src = "https://user:password@example.test/private"; },
    (doc: any) => { doc.cover.src = "//evil.test/x"; },
    (doc: any) => { doc.cover.privateOriginal = "PRIVATE"; },
    (doc: any) => { doc.publishedAt = "2026-02-30T00:00:00Z"; },
    (doc: any) => { doc.body[0].children[0].marks = ["unregistered"]; },
    (doc: any) => { doc.body[0]._type = "iframe"; },
    (doc: any) => { doc.body[0].markDefs = [{ _key: "l1", _type: "link", href: "javascript:alert(1)" }]; }
  ])("rejects poisoned nested document %#", async change => {
    const doc = article(); change(doc); release.snapshotText = JSON.stringify([doc]); release.payloadChecksum = marketingChecksum(release.snapshotText);
    await expect(read()).rejects.toMatchObject({ code: "unavailable" });
  });
  it.each(["{}", "null", "[", JSON.stringify(Array(101).fill(article())), JSON.stringify([article(), article()]), " [ ]", "[" + " ".repeat(1048576) + "]"])("rejects malformed, duplicate, non-stable or oversized snapshots %#", text => {
    expect(() => parseMarketingSnapshot(text, marketingChecksum(text))).toThrow();
  });
  it("rejects poisoned checksum and version without fallback", async () => {
    release.payloadChecksum = "0".repeat(64); await expect(read()).rejects.toMatchObject({ code: "unavailable" });
    release.payloadChecksum = marketingChecksum(release.snapshotText); release.version = 2;
    await expect(read()).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("bearer read boundary", () => {
  it.each([null, "", "Bearer prefix", "Bearer " + "x".repeat(200), authorization + " extra", `Basic ${token}`])("rejects invalid credentials before DB %#", async auth => {
    await expect(read(auth)).rejects.toMatchObject({ code: "unauthorized" }); expect(mocks.db).not.toHaveBeenCalled();
  });
  it.each(["missing", "expired", "revoked", "cross-dataset", "wrong-scope"])("denies %s identically", async kind => {
    if (kind === "missing") credential = null;
    if (kind === "expired") credential.expiresAt = new Date(0);
    if (kind === "revoked") credential.revokedAt = new Date("2099-01-01");
    if (kind === "cross-dataset") credential.datasetId = id(99);
    if (kind === "wrong-scope") credential.type = "cms.write";
    const response = await get(); expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" }); expect(tx.cmsDataset.findUnique).not.toHaveBeenCalled();
  });
  it.each(["missing", "revoked", "null-pointer"])("never selects latest release when pointer %s", async kind => {
    if (kind === "missing") dataset.activeMarketingPublication = null;
    if (kind === "revoked") dataset.activeMarketingPublication.status = "revoked";
    if (kind === "null-pointer") dataset.activeMarketingPublication.releaseId = null;
    expect((await get()).status).toBe(404); expect(tx.cmsMarketingRelease.findMany).not.toHaveBeenCalled();
  });
  it.each(["dataset", "organization", "owner", "site", "cross-site"])("denies inactive scope %s", async kind => {
    if (kind === "dataset") dataset.archivedAt = new Date();
    if (kind === "organization") dataset.organization.deletedAt = new Date();
    if (kind === "owner") dataset.organization.owner.deletedAt = new Date();
    if (kind.includes("site")) { dataset.siteId = id(9); dataset.site = { id: id(9), organizationId: orgId, deletedAt: new Date() }; }
    if (kind === "cross-site") { dataset.site.deletedAt = null; dataset.site.organizationId = id(99); }
    expect((await get()).status).toBe(404);
  });
  it("retains reads on downgrade and disabled authoring flags", async () => {
    dataset.organization.owner.subscriptionPlanId = "starter"; dataset.organization.owner.subscriptionStatus = "canceled";
    vi.stubEnv("JONGO_CMS_ENABLED", "false"); vi.stubEnv("JONGO_CMS_WRITES_ENABLED", "false");
    expect((await get()).status).toBe(200);
  });
  it("emits private no-store ETag; conditional requests reauthenticate and recheck pointer", async () => {
    const response = await get(); const etag = response.headers.get("etag")!;
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("vary")).toBe("Authorization");
    expect((await get(authorization, etag)).status).toBe(304);
    credential.revokedAt = new Date(); expect((await get(authorization, etag)).status).toBe(401);
    credential.revokedAt = null; dataset.activeMarketingPublication.status = "revoked";
    expect((await get(authorization, etag)).status).toBe(404);
  });
  it("redacts unexpected errors without console calls", async () => {
    const error = vi.spyOn(console, "error"), warn = vi.spyOn(console, "warn");
    tx.cmsDataset.findUnique.mockRejectedValue(new Error("SQL PRIVATE SECRET"));
    const response = await get(); expect(response.status).toBe(503); expect(await response.text()).not.toMatch(/SQL|PRIVATE|SECRET/);
    expect(error).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled(); error.mockRestore(); warn.mockRestore();
  });
});

describe("locked internal issuance and publication", () => {
  it("mints only a hash, returns raw secret once, and never puts it in audit", async () => {
    const result = await mintMarketingDeliveryCredential(ownerId, datasetId);
    expect(result.token).toMatch(/^jcms_[A-Za-z0-9_-]{43}$/);
    const data = tx.cmsDeliveryCredential.create.mock.calls[0][0].data;
    expect(data.tokenHash).toBe(deliveryTokenHash(`Bearer ${result.token}`)); expect(data).not.toHaveProperty("token");
    expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain(result.token);
    expect(tx.auditLog.create.mock.calls[0][0].data.organizationId).toBe(orgId);
    expect(tx.$queryRaw.mock.calls.some((call: any[]) => call[0].join("").includes('"CmsDataset"'))).toBe(true);
    expect(tx.$transaction.mock.calls[0][1].isolationLevel).toBe("Serializable");
  });
  it.each(["flag", "writes", "downgrade", "editor", "publisher", "deleted"])("denies mint on fresh %s", async kind => {
    if (kind === "flag") vi.stubEnv("JONGO_CMS_ENABLED", "false");
    if (kind === "writes") vi.stubEnv("JONGO_CMS_WRITES_ENABLED", "false");
    if (kind === "downgrade") dataset.organization.owner.subscriptionPlanId = "starter";
    if (kind === "deleted") dataset.organization.owner.deletedAt = new Date();
    if (kind === "editor" || kind === "publisher") {
      dataset.organization.ownerId = id(90); dataset.organization.owner.id = id(90);
      dataset.organization.collaborators = [{ organizationId: orgId, userId: ownerId, role: "collaborator", deletedAt: null }];
      dataset.grants = [{ datasetId, userId: ownerId, role: kind, revokedAt: null }];
    }
    await expect(mintMarketingDeliveryCredential(ownerId, datasetId)).rejects.toMatchObject({ code: "denied" });
    expect(tx.cmsDeliveryCredential.create).not.toHaveBeenCalled();
  });
  it("rechecks policy after lock, not just preliminary authority", async () => {
    tx.$queryRaw.mockImplementation(async () => { dataset.organization.owner.subscriptionPlanId = "starter"; return []; });
    await expect(mintMarketingDeliveryCredential(ownerId, datasetId)).rejects.toMatchObject({ code: "denied" });
    expect(tx.cmsDeliveryCredential.create).not.toHaveBeenCalled();
  });
  it("revokes only the dataset-bound credential", async () => {
    await revokeMarketingDeliveryCredential(ownerId, datasetId, id(7));
    expect(tx.cmsDeliveryCredential.updateMany).toHaveBeenCalledWith({ where: { id: id(7), datasetId, revokedAt: null }, data: { revokedAt: expect.any(Date) } });
  });
  it("rejects expired issuance and empty release, no DB calls", async () => {
    await expect(mintMarketingDeliveryCredential(ownerId, datasetId, new Date(0))).rejects.toMatchObject({ code: "invalid" });
    await expect(createMarketingRelease(ownerId, datasetId, [], 0, publish)).rejects.toMatchObject({ code: "invalid" });
    expect(mocks.db).not.toHaveBeenCalled();
  });
  it("checks pointer CAS before any revision access", async () => {
    await expect(createMarketingRelease(ownerId, datasetId, [revisionId], 1, publish)).rejects.toMatchObject({ code: "conflict" });
    expect(tx.cmsRevision.findMany).not.toHaveBeenCalled();
  });
  it("checks revisions freshly and refuses missing selections", async () => {
    await expect(createMarketingRelease(ownerId, datasetId, [revisionId], 0, publish)).rejects.toMatchObject({ code: "invalid" });
    expect(tx.cmsRevision.findMany.mock.calls[0][0].where).toEqual({ datasetId, id: { in: [revisionId] } });
    expect(tx.cmsMarketingRelease.create).not.toHaveBeenCalled();
  });
});

describe("exact middleware exemption", () => {
  const path = `/api/content/v1/datasets/${datasetId}/marketing`;
  it("allows exact GET to reach its independent bearer handler", async () => {
    const response = await middleware(new NextRequest(`http://localhost${path}`));
    expect(response.headers.get("x-middleware-next")).toBe("1"); expect(mocks.jwt).not.toHaveBeenCalled();
  });
  it.each([path + "/", path + "/drafts", path + "-other", path.replace(datasetId, "not-a-uuid"), "/api/content/v1/datasets", "/api/content/v1/drafts"])("does not broadly exempt %s", async pathname => {
    expect((await middleware(new NextRequest(`http://localhost${pathname}`))).status).toBe(307);
  });
  it.each(["POST", "PUT", "DELETE", "HEAD"])("does not exempt %s", async method => {
    expect((await middleware(new NextRequest(`http://localhost${path}`, { method }))).status).toBe(307);
  });
});