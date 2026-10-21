import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
const mocks = vi.hoisted(() => ({ db: vi.fn(), getDb: vi.fn() }));
vi.mock("./delivery-db", () => ({ getDeliveryDb: mocks.db }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
import { createMarketingRelease, rollbackMarketingRelease, unpublishMarketing } from "./marketing-publication";
import { parseMarketingSnapshot } from "./marketing-snapshot";
import { assertLocalDatabase } from "./import/local-database";
import { parseArguments } from "../../../../../scripts/publish-marketing-release";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const datasetId = id(1), ownerId = id(3), orgId = id(4), oldRelease = id(9);
const origins = { publicOrigins: ["https://media.example"] };
// Synthetic fixtures only; no real people, approvals or production records.
const envelope = (nativeId: string, type: string) => ({ _id: nativeId, _type: type, _rev: "r1",
  _createdAt: "2026-10-01T00:00:00Z", _updatedAt: "2026-10-01T00:00:00Z" });
const approval = { status: "approved", evidence: "Synthetic evidence", reviewer: "Synthetic reviewer", approvedAt: "2026-10-01T00:00:00Z" };
const provenance = { source: "Synthetic test fixture" };
const asset = (ref: string) => ({ _type: "reference", _ref: ref });
const work = (): any => ({ ...envelope("drafts.work.alpha", "agencyWork"), slug: { _type: "slug", current: "alpha" },
  clientName: "Alpha", category: "Brand", tone: "sage", cardAsset: asset("image-card"),
  gallery: [{ _type: "mediaImage", _key: "g1", asset: asset("image-gallery"), alt: "Gallery view" }],
  services: ["Design"], headline: "Synthetic headline", detailSummary: "One synthetic sentence.", provenance, publicationApproval: approval });
const story = (): any => ({ ...envelope("drafts.story.beta", "partnerStories"), slug: { _type: "slug", current: "beta" },
  company: "Beta", personName: "Pat Synthetic", role: "Director", textBadge: "Beta",
  portrait: { _type: "mediaImage", asset: asset("image-portrait"), alt: "Portrait" }, quote: "Synthetic quote.", tone: "lime",
  consent: { ...approval, quote: true, likeness: true }, provenance });
const article = (): any => ({ ...envelope("drafts.article.gamma", "article"), slug: { _type: "slug", current: "gamma" },
  title: "Gamma", excerpt: "Synthetic excerpt", publishedAt: "2026-10-01T00:00:00Z",
  body: [{ _type: "block", _key: "b1", style: "normal", children: [{ _type: "span", _key: "s1", text: "Body", marks: [] }], markDefs: [] },
    { _type: "image", _key: "i1", asset: asset("image-body"), alt: "Body image" }],
  cover: { _type: "mediaImage", asset: asset("image-cover"), alt: "Cover" }, provenance, publicationApproval: approval });
function revisionRow(n: number, payload: any) {
  return { id: id(10 + n), datasetId, documentId: id(20 + n), schemaVersion: 1, payload,
    document: { id: id(20 + n), datasetId, currentRevisionId: id(10 + n), archivedAt: null, type: payload._type, nativeId: payload._id,
      logicalId: payload._id.replace(/^drafts\./, ""), variant: payload._id.startsWith("drafts.") ? "draft" : "published" } };
}
function mediaRow(nativeId: string, n: number, status = "approved") {
  const rowId = id(100 + n), hash = String(n).padStart(64, "0"), objectKey = `${datasetId}/${rowId}/${hash}.webp`;
  return { id: rowId, datasetId, nativeId, assetType: "sanity.imageAsset", objectKey, url: `https://media.example/assets/${objectKey}`,
    sha256: hash, mimeType: "image/webp", width: 10, height: 10, byteSize: 100, alt: `Alt ${nativeId}`, caption: "", status,
    reviewerId: ownerId, approvedAt: new Date("2026-10-02T00:00:00Z"), createdBy: ownerId, createdAt: new Date("2026-10-01T00:00:00Z") };
}
let tx: any, dataset: any, revisions: any[], media: any[], documents: any[], publication: any, release: any;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("JONGO_CMS_ENABLED", "true"); vi.stubEnv("JONGO_CMS_WRITES_ENABLED", "true");
  dataset = { id: datasetId, archivedAt: null, organizationId: orgId, siteId: null, grants: [], site: null,
    organization: { id: orgId, ownerId, deletedAt: null, collaborators: [], owner: { id: ownerId, deletedAt: null,
      subscriptionPlanId: "core-sla", subscriptionStatus: "active", subscriptionCurrentPeriodEnd: new Date("2030-01-01T00:00:00Z") } } };
  revisions = [revisionRow(1, work()), revisionRow(2, story()), revisionRow(3, article())];
  media = ["image-card", "image-gallery", "image-portrait", "image-body", "image-cover"].map((native, n) => mediaRow(native, n + 1));
  documents = []; publication = null; release = null;
  const delegate = () => ({ findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]),
    create: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) });
  tx = { user: delegate(), cmsDataset: delegate(), cmsDocument: delegate(), cmsRevision: delegate(), cmsReference: delegate(),
    cmsMarketingRelease: delegate(), cmsMarketingPublication: delegate(), cmsContentOutbox: delegate(), auditLog: delegate(),
    cmsApprovedMedia: delegate(), cmsDeliveryCredential: delegate(), cmsMutation: delegate(), $executeRaw: vi.fn(), $queryRaw: vi.fn() };
  tx.user.findUnique.mockResolvedValue({ id: ownerId, deletedAt: null });
  tx.cmsDataset.findUnique.mockImplementation(async () => dataset);
  tx.cmsMarketingPublication.findUnique.mockImplementation(async () => publication);
  tx.cmsMarketingRelease.findFirst.mockImplementation(async (query: any) => query.where.id ? release : null);
  // Returned out of order: publication order must come from the caller, not the DB.
  tx.cmsRevision.findMany.mockImplementation(async ({ where }: any) => revisions.filter(row => where.id.in.includes(row.id)).reverse());
  tx.cmsDocument.findMany.mockImplementation(async ({ where }: any) => documents.filter(doc => where.logicalId.in.includes(doc.logicalId)));
  tx.cmsApprovedMedia.findMany.mockImplementation(async ({ where }: any) => media.filter(row => row.datasetId === where.datasetId &&
    row.status === where.status && (where.nativeId ? where.nativeId.in.includes(row.nativeId) : where.url.in.includes(row.url))));
  tx.$transaction = vi.fn(async (action: any) => action(tx));
  mocks.db.mockReturnValue(tx);
});
afterEach(() => vi.unstubAllEnvs());
const all = [id(13), id(11), id(12)];
const publish = (ids = all, expected = 0) => createMarketingRelease(ownerId, datasetId, ids, expected, origins);
const noWrites = () => {
  expect(tx.cmsMarketingRelease.create).not.toHaveBeenCalled(); expect(tx.cmsMarketingPublication.create).not.toHaveBeenCalled();
  expect(tx.cmsMarketingPublication.updateMany).not.toHaveBeenCalled(); expect(tx.cmsContentOutbox.create).not.toHaveBeenCalled();
  expect(tx.auditLog.create).not.toHaveBeenCalled();
};

describe("createMarketingRelease", () => {
  it("promotes drafts explicitly, preserves caller order and hashes the exact snapshot text", async () => {
    const before = JSON.stringify(revisions.map(row => row.payload));
    const receipt = await publish();
    const data = tx.cmsMarketingRelease.create.mock.calls[0][0].data;
    const docs = parseMarketingSnapshot(data.snapshotText, data.payloadChecksum);
    expect(docs.map(doc => [doc.kind, doc.id])).toEqual([["article", "article.gamma"], ["workCaseStudy", "work.alpha"], ["testimonial", "story.beta"]]);
    expect(data.snapshotText).toBe(JSON.stringify(docs));
    expect(data.payloadChecksum).toBe(createHash("sha256").update(data.snapshotText, "utf8").digest("hex"));
    expect(data.payload).toEqual({ documents: docs });
    expect(data).toMatchObject({ datasetId, sequence: 1, version: 1, actorId: ownerId });
    expect(docs[1]).toMatchObject({ cardImage: { src: media[0].url, alt: "Alt image-card", caption: "" },
      gallery: [{ src: media[1].url, alt: "Gallery view", caption: "" }] });
    expect(JSON.stringify(docs)).not.toMatch(/drafts\.|publicationApproval|consent|provenance|objectKey|sha256/);
    expect(receipt).toEqual({ datasetId, releaseId: data.id, sequence: 1, publicationRevision: 1, checksum: data.payloadChecksum, documentCount: 3 });
    expect(tx.cmsMarketingPublication.create).toHaveBeenCalledWith({ data: { datasetId, releaseId: data.id, status: "active", actorId: ownerId, revision: 1 } });
    expect(tx.cmsContentOutbox.create.mock.calls[0][0].data).toMatchObject({ datasetId, releaseId: data.id, publicationRevision: 1, eventType: "release_publish" });
    expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({ organizationId: orgId, action: "cms.marketing.release.publish",
      details: { releaseId: data.id, revisionIds: all, documentCount: 3 } });
    // Stored drafts are not mutated and no revision write is attempted.
    expect(JSON.stringify(revisions.map(row => row.payload))).toBe(before);
    expect(tx.cmsRevision.create).not.toHaveBeenCalled(); expect(tx.cmsRevision.updateMany).not.toHaveBeenCalled();
    expect(tx.$transaction.mock.calls[0][1].isolationLevel).toBe("Serializable");
  });
  it("orders differently when the caller does", async () => {
    await publish([id(12), id(11)]);
    const docs = JSON.parse(tx.cmsMarketingRelease.create.mock.calls[0][0].data.snapshotText);
    expect(docs.map((doc: any) => doc.kind)).toEqual(["testimonial", "workCaseStudy"]);
  });
  it("CAS-updates an existing pointer and allocates the next sequence", async () => {
    publication = { revision: 3 };
    tx.cmsMarketingRelease.findFirst.mockImplementation(async () => ({ sequence: 4 }));
    const receipt = await publish(all, 3);
    expect(receipt).toMatchObject({ sequence: 5, publicationRevision: 4 });
    expect(tx.cmsMarketingPublication.updateMany).toHaveBeenCalledWith({ where: { datasetId, revision: 3 },
      data: { releaseId: receipt.releaseId, status: "active", actorId: ownerId, revision: 4 } });
  });
  it("refuses a stale expected revision before reading revisions", async () => {
    publication = { revision: 2 };
    await expect(publish(all, 1)).rejects.toMatchObject({ code: "conflict" });
    expect(tx.cmsRevision.findMany).not.toHaveBeenCalled(); noWrites();
  });
  it("reports conflict when the pointer moved inside the transaction", async () => {
    publication = { revision: 1 };
    tx.cmsMarketingPublication.updateMany.mockResolvedValue({ count: 0 });
    await expect(publish(all, 1)).rejects.toMatchObject({ code: "conflict" });
  });
  it.each([
    ["empty release", () => []],
    ["more than 100", () => Array.from({ length: 101 }, (_, n) => id(1000 + n))],
    ["duplicate ids", () => [id(11), id(11)]],
    ["non-uuid", () => ["drafts.work.alpha"]]
  ])("refuses %s without DB access", async (_, ids) => {
    await expect(publish(ids())).rejects.toMatchObject({ code: "invalid" }); expect(mocks.db).not.toHaveBeenCalled();
  });
  it.each([[[]], [["http://media.example"]], [["https://media.example/assets"]]])("refuses bad server origin config %# before DB", async publicOrigins => {
    await expect(createMarketingRelease(ownerId, datasetId, all, 0, { publicOrigins })).rejects.toMatchObject({ code: "invalid" });
    expect(mocks.db).not.toHaveBeenCalled();
  });
  it.each<[string, () => void]>([
    ["publication approval pending", () => { revisions[0].payload.publicationApproval = { ...approval, status: "pending" }; }],
    ["publication approval missing", () => { delete revisions[2].payload.publicationApproval; }],
    ["likeness consent missing", () => { revisions[1].payload.consent.likeness = false; }],
    ["consent status not approved", () => { revisions[1].payload.consent.status = "pending"; }],
    ["quarantined unknown field", () => { revisions[0].payload.privateNotes = "x"; }],
    ["unresolved strong reference", () => { revisions[1].payload.relatedWork = asset("work.missing"); revisions[1].payload.relatedWorkVerified = true; }],
    ["draft-prefixed strong reference", () => { revisions[1].payload.relatedWork = asset("drafts.work.alpha"); revisions[1].payload.relatedWorkVerified = true; }],
    ["missing media", () => { media.splice(2, 1); }],
    ["pending media", () => { media[0].status = "pending"; }],
    ["revoked media", () => { media[4].status = "revoked"; }],
    ["not the current revision", () => { revisions[0].document.currentRevisionId = id(99); }],
    ["archived document", () => { revisions[1].document.archivedAt = new Date(); }],
    ["cross-dataset document", () => { revisions[1].document.datasetId = id(98); }],
    ["unsupported type", () => { revisions[0].document.type = "signalCaseStudy"; }],
    ["outdated schema version", () => { revisions[2].schemaVersion = 0; }],
    ["payload/document identity mismatch", () => { revisions[0].document.nativeId = "drafts.work.other"; revisions[0].document.logicalId = "work.other"; }],
    ["variant mismatch", () => { revisions[0].document.variant = "published"; }],
    ["duplicate logical id", () => { revisions.push(revisionRow(4, { ...work(), _id: "work.alpha" })); }],
    ["duplicate public route", () => { revisions.push(revisionRow(4, { ...work(), _id: "drafts.work.other" })); }],
    ["missing selected revision", () => { revisions.pop(); }]
  ])("refuses %s with no release writes", async (name, change) => {
    change();
    const ids = name.startsWith("duplicate") ? [...all, id(14)] : all;
    await expect(publish(ids)).rejects.toMatchObject({ code: "invalid" }); noWrites();
  });
  it("resolves strong references only to live same-dataset logical documents", async () => {
    revisions[1].payload.relatedWork = asset("work.alpha"); revisions[1].payload.relatedWorkVerified = true;
    documents = [{ datasetId, logicalId: "work.alpha", type: "agencyWork" }];
    await publish();
    expect(tx.cmsDocument.findMany.mock.calls[0][0].where).toEqual({ datasetId, archivedAt: null, logicalId: { in: ["work.alpha"] } });
    expect(tx.cmsMarketingRelease.create.mock.calls[0][0].data.snapshotText).not.toContain("relatedWork");
  });
  it("refuses a reference to the wrong target type", async () => {
    revisions[1].payload.relatedWork = asset("article.gamma"); revisions[1].payload.relatedWorkVerified = true;
    documents = [{ datasetId, logicalId: "article.gamma", type: "article" }];
    await expect(publish()).rejects.toMatchObject({ code: "invalid" }); noWrites();
  });
  it("loads exactly the referenced media inside the publish transaction", async () => {
    await publish();
    const where = tx.cmsApprovedMedia.findMany.mock.calls[0][0].where;
    expect(where.datasetId).toBe(datasetId); expect(where.status).toBe("approved");
    expect([...where.nativeId.in].sort()).toEqual(["image-body", "image-card", "image-cover", "image-gallery", "image-portrait"]);
  });
  it("denies an editor-only grant before any read", async () => {
    dataset.organization.ownerId = id(90); dataset.organization.owner.id = id(90);
    dataset.organization.collaborators = [{ organizationId: orgId, userId: ownerId, role: "collaborator", deletedAt: null }];
    dataset.grants = [{ datasetId, userId: ownerId, role: "editor", revokedAt: null }];
    await expect(publish()).rejects.toMatchObject({ code: "denied" });
    expect(tx.cmsRevision.findMany).not.toHaveBeenCalled(); noWrites();
  });
  it("denies a downgraded sponsor", async () => {
    dataset.organization.owner.subscriptionPlanId = "starter";
    await expect(publish()).rejects.toMatchObject({ code: "denied" }); noWrites();
  });
});

describe("unpublishMarketing", () => {
  it("clears the pointer, emits an unpublish event and audits; never deletes the release", async () => {
    publication = { revision: 1, status: "active", releaseId: oldRelease };
    expect(await unpublishMarketing(ownerId, datasetId, 1)).toEqual({ datasetId, releaseId: oldRelease, publicationRevision: 2 });
    expect(tx.cmsMarketingPublication.updateMany).toHaveBeenCalledWith({ where: { datasetId, revision: 1 },
      data: { releaseId: null, status: "revoked", actorId: ownerId, revision: 2 } });
    expect(tx.cmsContentOutbox.create.mock.calls[0][0].data).toMatchObject({ releaseId: oldRelease, publicationRevision: 2, eventType: "release_unpublish" });
    expect(tx.auditLog.create.mock.calls[0][0].data.action).toBe("cms.marketing.release.unpublish");
    expect(tx.cmsMarketingRelease.create).not.toHaveBeenCalled();
  });
  it.each([[null, 1], [{ revision: 2, status: "active", releaseId: oldRelease }, 1], [{ revision: 1, status: "revoked", releaseId: null }, 1]])
  ("refuses stale or inactive pointer %#", async (state, expected) => {
    publication = state;
    await expect(unpublishMarketing(ownerId, datasetId, expected)).rejects.toMatchObject({ code: "conflict" }); noWrites();
  });
  it("refuses invalid expected revision without DB", async () => {
    await expect(unpublishMarketing(ownerId, datasetId, 0)).rejects.toMatchObject({ code: "invalid" }); expect(mocks.db).not.toHaveBeenCalled();
  });
});

describe("local release CLI guard", () => {
  const base = ["--dataset-id", datasetId, "--actor-id", ownerId, "--confirm-dataset", datasetId, "--expected-revision", "0"];
  it("parses publish order, unpublish and rollback", () => {
    expect(parseArguments(["publish", ...base, "--revision-id", id(13), "--revision-id", id(11), "--public-origin", "https://media.example"]))
      .toMatchObject({ command: "publish", revisionIds: [id(13), id(11)], publicOrigins: ["https://media.example"], expectedRevision: 0 });
    expect(parseArguments(["unpublish", ...base])).toMatchObject({ command: "unpublish", revisionIds: [] });
    expect(parseArguments(["rollback", ...base, "--release-id", oldRelease])).toMatchObject({ command: "rollback", releaseId: oldRelease });
  });
  it.each([[["publish", ...base]], [["publish", ...base, "--revision-id", id(13)]], [["unpublish", ...base, "--revision-id", id(13)]],
    [["rollback", ...base]], [["deploy", ...base]], [["unpublish", ...base.slice(0, 4), "--confirm-dataset", id(98), ...base.slice(6)]],
    [["unpublish", ...base, "--dataset-id", datasetId]], [["unpublish", ...base.slice(0, 6), "--expected-revision", "-1"]]])
  ("rejects unsafe arguments %#", argv => { expect(() => parseArguments(argv)).toThrow(); });
  it("accepts only loopback cms_release_test_/cms_import_test_ names for the release CLI", () => {
    const env = (name: string, host = "127.0.0.1") => ({ NODE_ENV: "test", DATABASE_NAME: name, DATABASE_URL: `postgresql://x:x@${host}/${name}?schema=public` }) as NodeJS.ProcessEnv;
    const release = ["cms_import_test_", "cms_release_test_"] as const;
    expect(assertLocalDatabase(env("cms_release_test_one"), release)).toBe("cms_release_test_one");
    expect(assertLocalDatabase(env("cms_import_test_one"), release)).toBe("cms_import_test_one");
    expect(() => assertLocalDatabase(env("cms_release_test_one"))).toThrow();
    for (const bad of [env("cms_release_test_"), env("postgres"), env("cms_release_test_one", "db.example"), { ...env("cms_release_test_one"), NODE_ENV: "production" } as NodeJS.ProcessEnv])
      expect(() => assertLocalDatabase(bad, release)).toThrow();
  });
});

describe("rollbackMarketingRelease", () => {
  async function retained() {
    await publish();
    const data = tx.cmsMarketingRelease.create.mock.calls[0][0].data;
    release = { id: oldRelease, datasetId, version: 1, snapshotText: data.snapshotText, payloadChecksum: data.payloadChecksum };
    vi.clearAllMocks(); mocks.db.mockReturnValue(tx);
    return data;
  }
  it("re-points to a retained release after verifying snapshot and still-approved media", async () => {
    const data = await retained();
    publication = { revision: 2, status: "revoked", releaseId: null };
    expect(await rollbackMarketingRelease(ownerId, datasetId, oldRelease, 2)).toEqual({ datasetId, releaseId: oldRelease, publicationRevision: 3 });
    expect(tx.cmsMarketingPublication.updateMany).toHaveBeenCalledWith({ where: { datasetId, revision: 2 },
      data: { releaseId: oldRelease, status: "active", actorId: ownerId, revision: 3 } });
    expect(tx.cmsContentOutbox.create.mock.calls[0][0].data).toMatchObject({ releaseId: oldRelease, publicationRevision: 3, eventType: "release_publish",
      payload: { checksum: data.payloadChecksum, rollback: true } });
    expect(tx.auditLog.create.mock.calls[0][0].data.action).toBe("cms.marketing.release.rollback");
    expect(tx.cmsMarketingRelease.create).not.toHaveBeenCalled();
  });
  it.each<[string, () => void, string]>([
    ["revoked media", () => { media[3].status = "revoked"; }, "invalid"],
    ["tampered snapshot", () => { release.snapshotText = release.snapshotText.replace("Gamma", "Gamme"); }, "invalid"],
    ["unknown release", () => { release = null; }, "invalid"],
    ["other dataset release", () => { release.datasetId = id(98); }, "invalid"],
    ["already active release", () => { publication = { revision: 2, status: "active", releaseId: oldRelease }; }, "conflict"],
    ["stale revision", () => { publication = { revision: 5, status: "revoked", releaseId: null }; }, "conflict"]
  ])("refuses %s", async (_, change, code) => {
    await retained();
    publication = { revision: 2, status: "revoked", releaseId: null };
    change();
    await expect(rollbackMarketingRelease(ownerId, datasetId, oldRelease, 2)).rejects.toMatchObject({ code }); noWrites();
  });
});
