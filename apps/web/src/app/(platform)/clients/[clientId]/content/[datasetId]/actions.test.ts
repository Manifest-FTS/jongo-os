import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ auth: vi.fn(), caps: vi.fn(), get: vi.fn(), save: vi.fn(), db: vi.fn(),
  createRelease: vi.fn(), unpublish: vi.fn(), mint: vi.fn(), revoke: vi.fn() }));
vi.mock("@/lib/auth.config", () => ({ auth: m.auth }));
vi.mock("@/lib/cms/dataset-access", () => ({ resolveDatasetCmsCapabilities: m.caps }));
vi.mock("@/lib/db", () => ({ getDb: m.db }));
vi.mock("@/lib/cms/documents", async (original) => ({
  ...await original<typeof import("@/lib/cms/documents")>(), getCmsDocument: m.get, saveCmsDraftForm: m.save
}));
vi.mock("@/lib/cms/marketing-publication", () => ({ createMarketingRelease: m.createRelease, unpublishMarketing: m.unpublish }));
vi.mock("@/lib/cms/deliverycredentials", () => ({ mintMarketingDeliveryCredential: m.mint, revokeMarketingDeliveryCredential: m.revoke }));
import { createDraftSaveAction, createMarketingAdminActions } from "./actions";
import { CmsDocumentError } from "@/lib/cms/documents";
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const clientId = id(1), datasetId = id(2), userId = id(3), documentId = id(4);
const envelope = { _id: `drafts.${id(5)}`, _type: "partnerStories", _rev: "native.initial.marker",
  _createdAt: "2026-10-19T12:00:00.000Z", _updatedAt: "2026-10-19T12:00:00.000Z" };
const values = { company: "Example", personName: "Person", role: "Partner", quote: "Private quote", tone: "lime", textBadge: "Example" };
const request = () => ({ documentId: null as string | null, expectedNativeRev: null as string | null,
  mutationId: id(6), serializedForm: JSON.stringify(values) });
const action = () => createDraftSaveAction({ clientId, datasetId, envelope });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("JONGO_CMS_ENABLED", "true"); vi.stubEnv("JONGO_CMS_WRITES_ENABLED", "true");
  m.auth.mockResolvedValue({ user: { id: userId, role: "super_admin" } });
  m.caps.mockResolvedValue({ scope: "dataset", datasetId, organizationId: clientId, canRead: true, canEdit: true, canPublish: true, canManageDataset: true });
  m.get.mockResolvedValue({ document: { id: documentId, datasetId, nativeId: envelope._id, type: envelope._type }, draft: { nativeRev: "fresh" } });
  m.save.mockResolvedValue({ documentId, nativeRev: "fresh" });
  m.db.mockResolvedValue({ cmsRevision: { findMany: vi.fn().mockResolvedValue([
    { id: id(7), datasetId, documentId, document: { id: documentId, datasetId, currentRevisionId: id(7), archivedAt: null, type: "article", variant: "draft" } }
  ]) } });
  m.createRelease.mockResolvedValue({ publicationRevision: 4, documentCount: 1 });
  m.unpublish.mockResolvedValue({ publicationRevision: 5 });
  m.mint.mockResolvedValue({ id: id(8), token: `jcms_${"x".repeat(43)}` });
  m.revoke.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("authenticated dataset draft actions", () => {
  it("saves with session identity and server envelope only, returning no payload", async () => {
    expect(await action()(request())).toEqual({ status: "saved", documentId, nativeRev: "fresh" });
    expect(m.save).toHaveBeenCalledWith({ userId, datasetId, sourceId: envelope._id,
      envelope, serializedForm: JSON.stringify(values), mutationId: id(6), expectedNativeRev: null });
    expect(m.get).not.toHaveBeenCalled();
  });
  it.each([undefined, {}, { email: "actor@example.test" }, { id: "not-uuid" }])("denies missing/invalid session ID %j", async (user) => {
    m.auth.mockResolvedValue({ user });
    expect(await action()(request())).toEqual({ status: "denied" });
    expect(m.caps).not.toHaveBeenCalled(); expect(m.save).not.toHaveBeenCalled();
  });
  it.each(["JONGO_CMS_ENABLED", "JONGO_CMS_WRITES_ENABLED"])("requires exact true for %s", async (flag) => {
    for (const value of [undefined, "false", "TRUE", "1", " true "]) {
      vi.stubEnv(flag, value);
      expect(await action()(request())).toEqual({ status: "denied" });
    }
    expect(m.save).not.toHaveBeenCalled(); expect(m.get).not.toHaveBeenCalled();
  });
  it.each(["organizationId", "datasetId", "canEdit", "canRead"])("rejects fresh wrong scope/downgrade %s before document queries", async (key) => {
    m.caps.mockResolvedValue({ scope: "dataset", datasetId, organizationId: clientId, canRead: true, canEdit: true,
      [key]: key.startsWith("can") ? false : id(90) });
    expect(await action()({ ...request(), documentId, expectedNativeRev: "old" })).toEqual({ status: "denied" });
    expect(m.get).not.toHaveBeenCalled(); expect(m.save).not.toHaveBeenCalled();
  });
  it.each(["userId", "caps", "sourceId", "expectedLockVersion", "input"])("rejects injected %s", async (key) => {
    expect(await action()({ ...request(), [key]: userId } as any)).toEqual({ status: "invalid" });
    expect(m.save).not.toHaveBeenCalled();
  });
  it.each([
    { documentId: "bad" }, { mutationId: "" }, { expectedNativeRev: "source-revision" },
    { serializedForm: JSON.stringify({ quote: "x".repeat(512 * 1024) }) }
  ])("rejects malformed/bounded arguments %j", async (override) => {
    expect((await action()({ ...request(), ...override })).status).toBe("invalid");
    expect(m.save).not.toHaveBeenCalled();
  });
  it("returns safe validation findings, not payload or nested private keys", async () => {
    m.save.mockRejectedValueOnce(new CmsDocumentError("invalid"));
    const result = await action()({ ...request(), serializedForm: JSON.stringify({ ...values, quote: "", consent: '{"PRIVATE_KEY":"PRIVATE_VALUE"}' }) });
    expect(result.status).toBe("invalid"); expect(result).toHaveProperty("findings");
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|Private quote/);
    expect(m.save).toHaveBeenCalledTimes(1);
  });
  it("binds existing source identity before saving", async () => {
    m.get.mockResolvedValue({ document: { datasetId, nativeId: "drafts.other", type: envelope._type }, draft: {} });
    expect(await action()({ ...request(), documentId, expectedNativeRev: "old" })).toEqual({ status: "denied" });
    expect(m.save).not.toHaveBeenCalled();
  });
  it("passes native preconditions unchanged for CAS and exact lost-response retries", async () => {
    const save = action();
    const r = { ...request(), documentId, expectedNativeRev: "old" };
    await save(r); await save(r);
    expect(m.save.mock.calls[0][0]).toEqual(m.save.mock.calls[1][0]);
    expect(m.save.mock.calls[0][0].expectedNativeRev).toBe("old");
    expect(m.save.mock.calls[0][0].envelope._rev).toBe(envelope._rev);
  });
  it("rechecks downgrade after earlier success", async () => {
    const save = action(); await save(request());
    m.caps.mockResolvedValue({ scope: "dataset", datasetId, organizationId: clientId, canRead: true, canEdit: false });
    expect(await save(request())).toEqual({ status: "denied" }); expect(m.save).toHaveBeenCalledTimes(1);
  });
  it.each(["conflict", "denied", "invalid", "unavailable"] as const)("sanitizes service %s", async (code) => {
    m.save.mockRejectedValue(new CmsDocumentError(code));
    expect(await action()(request())).toMatchObject({ status: code });
  });
  it("never exposes private exceptions", async () => {
    m.save.mockRejectedValue(new Error("PRIVATE_SQL_STACK_PAYLOAD"));
    expect(await action()(request())).toEqual({ status: "unavailable" });
  });
});

describe("dataset-bound marketing admin actions", () => {
  const admin = () => createMarketingAdminActions({ clientId, datasetId });
  const selected = { revisionIds: [id(7)], expectedRevision: 3 };

  it("publishes only current saved marketing drafts with session actor, route dataset and CAS", async () => {
    vi.stubEnv("CMS_PUBLIC_MEDIA_ORIGINS", "https://media.example, https://cdn.example");
    expect(await admin().publish(selected)).toEqual({ status: "ok", publicationRevision: 4, documentCount: 1 });
    expect(m.caps).toHaveBeenCalledWith(userId, datasetId);
    expect(m.createRelease).toHaveBeenCalledWith(userId, datasetId, [id(7)], 3,
      { publicOrigins: ["https://media.example", "https://cdn.example"] });
    expect((await m.db()).cmsRevision.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { datasetId, id: { in: [id(7)] } }
    }));
  });

  it.each(["missing actor", "wrong dataset", "wrong client", "no publish capability"])("denies publish on fresh %s", async kind => {
    if (kind === "missing actor") m.auth.mockResolvedValue({ user: { role: "admin" } });
    if (kind === "wrong dataset") m.caps.mockResolvedValue({ scope: "dataset", datasetId: id(90), organizationId: clientId, canRead: true, canPublish: true });
    if (kind === "wrong client") m.caps.mockResolvedValue({ scope: "dataset", datasetId, organizationId: id(90), canRead: true, canPublish: true });
    if (kind === "no publish capability") m.caps.mockResolvedValue({ scope: "dataset", datasetId, organizationId: clientId, canRead: true, canPublish: false });
    expect(await admin().publish(selected)).toEqual({ status: "denied" });
    expect(m.createRelease).not.toHaveBeenCalled(); expect(m.db).not.toHaveBeenCalled();
  });

  it.each([
    { revisionIds: [id(7), id(7)], expectedRevision: 0 },
    { revisionIds: ["drafts.article"], expectedRevision: 0 },
    { ...selected, actorId: userId },
    { revisionIds: [id(7)], expectedRevision: -1 }
  ])("rejects invalid or authority-bearing publish input %j", async input => {
    expect(await admin().publish(input as any)).toEqual({ status: "invalid" });
    expect(m.caps).not.toHaveBeenCalled(); expect(m.createRelease).not.toHaveBeenCalled();
  });

  it.each([
    { variant: "published" }, { archivedAt: new Date() }, { currentRevisionId: id(99) }, { type: "languageDictionary" }, { datasetId: id(99) }
  ])("refuses selected revision that is not a current same-dataset marketing draft: %j", async change => {
    const db = await m.db();
    db.cmsRevision.findMany.mockResolvedValueOnce([{ id: id(7), datasetId, documentId,
      document: { id: documentId, datasetId, currentRevisionId: id(7), archivedAt: null, type: "article", variant: "draft", ...change } }]);
    expect(await admin().publish(selected)).toEqual({ status: "invalid" });
    expect(m.createRelease).not.toHaveBeenCalled();
  });

  it("unpublishes by route-bound dataset and current expected publication revision", async () => {
    expect(await admin().unpublish({ expectedRevision: 3 })).toEqual({ status: "ok", publicationRevision: 5 });
    expect(m.unpublish).toHaveBeenCalledWith(userId, datasetId, 3);
    expect(await admin().unpublish({ expectedRevision: 3, datasetId: id(90) } as any)).toEqual({ status: "invalid" });
  });

  it("requires fresh manage capability for mint and returns the one-time token only as action result", async () => {
    const result = await admin().mint();
    expect(result).toEqual({ status: "ok", token: `jcms_${"x".repeat(43)}`, credentialId: id(8) });
    expect(m.mint).toHaveBeenCalledWith(userId, datasetId);
    m.caps.mockResolvedValue({ scope: "dataset", datasetId, organizationId: clientId, canRead: true, canManageDataset: false });
    expect(await admin().mint()).toEqual({ status: "denied" });
    expect(m.mint).toHaveBeenCalledTimes(1);
  });

  it("revokes only the validated credential ID in the captured dataset", async () => {
    expect(await admin().revoke({ credentialId: id(8) })).toEqual({ status: "ok" });
    expect(m.revoke).toHaveBeenCalledWith(userId, datasetId, id(8));
    expect(await admin().revoke({ credentialId: id(8), userId } as any)).toEqual({ status: "invalid" });
    expect(m.revoke).toHaveBeenCalledTimes(1);
  });

  it("sanitizes publication, unpublish and credential service errors", async () => {
    m.createRelease.mockRejectedValueOnce(new Error("PRIVATE_SQL_TOKEN"));
    expect(await admin().publish(selected)).toEqual({ status: "unavailable" });
    m.unpublish.mockRejectedValueOnce(new CmsDocumentError("conflict"));
    expect(await admin().unpublish({ expectedRevision: 3 })).toEqual({ status: "conflict" });
    m.mint.mockRejectedValueOnce(new Error("PRIVATE_TOKEN_HASH"));
    expect(await admin().mint()).toEqual({ status: "unavailable" });
  });
});