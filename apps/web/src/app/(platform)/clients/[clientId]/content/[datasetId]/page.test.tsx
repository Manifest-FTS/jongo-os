import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ auth: vi.fn(), caps: vi.fn(), get: vi.fn(), list: vi.fn(), db: vi.fn(), admin: vi.fn() }));
vi.mock("@/lib/auth.config", () => ({ auth: m.auth }));
vi.mock("@/lib/cms/dataset-access", () => ({ resolveDatasetCmsCapabilities: m.caps }));
vi.mock("@/lib/cms/documents", () => ({ getCmsDocument: m.get, listCmsDocuments: m.list }));
vi.mock("./actions", () => ({ createDraftSaveAction: () => async () => ({ status: "denied" }),
  createMarketingAdminActions: () => ({ publish: vi.fn(), unpublish: vi.fn(), mint: vi.fn(), revoke: vi.fn() }) }));
vi.mock("@/lib/db", () => ({ getDb: m.db }));
vi.mock("@/components/cms/MarketingAdminControls", async () => {
  const React = await import("react");
  return { default: (props: unknown) => { m.admin(props); return React.createElement("div", null, "Marketing admin controls"); } };
});
vi.mock("next/navigation", () => ({ notFound: () => { throw Object.assign(new Error("not found"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" }); } }));
import Page from "./page";
import DraftEditor from "@/components/cms/DraftEditor";
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const clientId = id(1), datasetId = id(2), userId = id(3), documentId = id(4);
const params = Promise.resolve({ clientId, datasetId });
let tx: any;
const draw = (query: any = {}) => Page({ params, searchParams: Promise.resolve(query) });
const editor = (element: React.ReactElement) => React.Children.toArray(element.props.children).find((n) => React.isValidElement(n) && n.type === DraftEditor) as React.ReactElement;
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("JONGO_CMS_ENABLED", "true"); vi.stubEnv("JONGO_CMS_WRITES_ENABLED", "true");
  m.auth.mockResolvedValue({ user: { id: userId } });
  m.caps.mockResolvedValue({ scope: "dataset", datasetId, organizationId: clientId, canRead: true, canEdit: true, canPublish: true, canManageDataset: true });
  m.list.mockResolvedValue([]);
  tx = { cmsMarketingPublication: { findUnique: vi.fn().mockResolvedValue(null) },
    cmsDeliveryCredential: { findMany: vi.fn().mockResolvedValue([]) }, cmsDocument: { findMany: vi.fn().mockResolvedValue([]) } };
  m.db.mockResolvedValue({ $transaction: vi.fn(async (callback: (snapshot: any) => unknown) => callback(tx)) });
  m.get.mockResolvedValue({ document: { id: documentId, datasetId, nativeId: "drafts.exact", type: "partnerStories" },
    draft: { nativeRev: "NATIVE_CAS", payload: { _id: "drafts.exact", _type: "partnerStories", _rev: "SOURCE_NOT_CAS", _createdAt: "2020-01-01T00:00:00Z", _updatedAt: "2020-01-01T00:00:00Z", company: "Saved company" } } });
});
afterEach(() => vi.unstubAllEnvs());
describe("dataset content route", () => {
  it("lists bounded drafts and links to creation without creating datasets", async () => {
    const html = renderToStaticMarkup(await draw());
    expect(html).toContain("New Testimonials &amp; partner stories draft");
    expect(html).toContain("New Work case studies draft");
    expect(html).toContain("New Articles draft");
    expect(html).not.toContain("Create dataset");
    expect(m.list).toHaveBeenCalledWith({ userId, datasetId, limit: 100, variant: "draft" });
    expect(m.admin).toHaveBeenCalledWith(expect.objectContaining({ canPublish: true, canManage: true,
      publication: { status: "revoked", revision: 0, hasRelease: false } }));
  });
  it("offers only saved current marketing draft revisions and selects metadata without hashes", async () => {
    tx.cmsMarketingPublication.findUnique.mockResolvedValue({ revision: 7, status: "active", releaseId: id(20) });
    tx.cmsDocument.findMany.mockResolvedValue([
      { id: id(10), datasetId, type: "agencyWork", nativeId: "drafts.work.saved", slug: "saved-work", currentRevisionId: id(11),
        currentRevision: { id: id(11), datasetId, documentId: id(10) } },
      { id: id(12), datasetId, type: "partnerStories", nativeId: "drafts.story.saved", slug: "saved-story", currentRevisionId: null, currentRevision: null },
      { id: documentId, datasetId, type: "article", nativeId: "drafts.article.saved", slug: "saved-article", currentRevisionId: id(9),
        currentRevision: { id: id(9), datasetId, documentId } }
    ]);
    tx.cmsDeliveryCredential.findMany.mockResolvedValue([{ id: id(30), prefix: "jcms:display", createdAt: new Date("2026-10-01T00:00:00.000Z"), expiresAt: null, revokedAt: null }]);
    renderToStaticMarkup(await draw());
    const props = m.admin.mock.calls.at(-1)![0] as any;
    expect(props.revisions).toEqual([
      { id: id(11), type: "agencyWork", label: "saved-work" },
      { id: id(9), type: "article", label: "saved-article" }
    ]);
    expect(props.publication).toEqual({ status: "active", revision: 7, hasRelease: true });
    expect(props.credentials).toEqual([{ id: id(30), prefix: "jcms:display", createdAt: "2026-10-01T00:00:00.000Z", expiresAt: null, revokedAt: null }]);
    const query = tx.cmsDeliveryCredential.findMany.mock.calls[0][0];
    expect(query.select).toEqual({ id: true, prefix: true, createdAt: true, expiresAt: true, revokedAt: true });
    expect(JSON.stringify(query)).not.toMatch(/token|hash/i);
  });
  it("reloads current persisted fields with separate native revision", async () => {
    const first = editor(await draw({ docId: documentId }));
    const props = first.props;
    expect(props.nativeRev).toBe("NATIVE_CAS"); expect(props.initialDocument.company).toBe("Saved company");
    expect(props.initialDocument._rev).toBe("SOURCE_NOT_CAS");
    expect(m.get).toHaveBeenCalledWith({ userId, datasetId, documentId });
    m.get.mockResolvedValueOnce({ document: { id: documentId, datasetId, nativeId: "drafts.exact", type: "partnerStories" },
      draft: { nativeRev: "NEXT_CAS", payload: { company: "Next saved company" } } });
    const next = editor(await draw({ docId: documentId }));
    expect(next.props.nativeRev).toBe("NEXT_CAS");
    expect(next.key).not.toBe(first.key); // reset editor only on explicit fresh server navigation
  });
  it("generates new native envelope on server only", async () => {
    const props = editor(await draw({ type: "partnerStories" })).props;
    expect(props.initialDocument._id).toMatch(/^drafts\.[0-9a-f-]{36}$/);
    expect(props.initialDocument._rev).toMatch(/^native\.initial\./);
    expect(new Date(props.initialDocument._createdAt).toISOString()).toBe(props.initialDocument._createdAt);
    expect(props.nativeRev).toBeNull(); expect(m.get).not.toHaveBeenCalled();
  });
  it.each(["organizationId", "datasetId", "canRead"])("denies wrong binding/access %s before document query", async (key) => {
    m.caps.mockResolvedValue({ scope: "dataset", datasetId, organizationId: clientId, canRead: true, canEdit: true, [key]: key === "canRead" ? false : id(99) });
    await expect(draw({ docId: documentId })).rejects.toThrow("not found");
    expect(m.get).not.toHaveBeenCalled(); expect(m.list).not.toHaveBeenCalled();
  });
  it.each([{}, { id: "bad" }])("denies missing/invalid identity %j", async (user) => {
    m.auth.mockResolvedValue({ user }); await expect(draw()).rejects.toThrow("not found");
    expect(m.caps).not.toHaveBeenCalled();
  });
  it.each([{ docId: "bad" }, { docId: [documentId] }, { type: "constructor" }, { type: ["agencyWork"] }, { afterId: "bad" }, { afterId: [documentId] }, { afterId: documentId, type: "agencyWork" }])("rejects invalid query %j", async (query) => {
    await expect(draw(query)).rejects.toThrow("not found"); expect(m.auth).not.toHaveBeenCalled();
  });
  it("requires valid route UUIDs before authorization", async () => {
    await expect(Page({ params: Promise.resolve({ clientId: "bad", datasetId }), searchParams: Promise.resolve({}) })).rejects.toThrow("not found");
    expect(m.auth).not.toHaveBeenCalled();
  });
  it("keeps reads after downgrade but removes saving", async () => {
    m.caps.mockResolvedValue({ scope: "dataset", datasetId, organizationId: clientId, canRead: true, canEdit: false });
    expect(editor(await draw({ docId: documentId })).props.canEdit).toBe(false);
    expect(renderToStaticMarkup(await draw())).not.toContain("Create draft");
  });
  it("defaults writes off independently of readable CMS", async () => {
    vi.stubEnv("JONGO_CMS_WRITES_ENABLED", undefined);
    expect(editor(await draw({ docId: documentId })).props.canEdit).toBe(false);
    vi.stubEnv("JONGO_CMS_ENABLED", "false");
    expect(renderToStaticMarkup(await draw())).toContain("feature is disabled");
  });
  it("fails closed for missing documents and sanitizes storage failures", async () => {
    m.get.mockResolvedValueOnce(null); await expect(draw({ docId: documentId })).rejects.toThrow("not found");
    m.get.mockRejectedValueOnce(new Error("PRIVATE_DB_STACK"));
    const html = renderToStaticMarkup(await draw({ docId: documentId }));
    expect(html).toContain("CMS unavailable"); expect(html).not.toContain("PRIVATE");
  });
  it("follows the last visible draft cursor, with lookahead and first-page navigation", async () => {
    const rows = Array.from({ length: 100 }, (_, n) => ({ id: id(100 + n), type: "partnerStories", nativeId: `drafts.${n}`, variant: "draft" }));
    m.list.mockResolvedValueOnce(rows).mockResolvedValueOnce([{ id: id(200) }]);
    const html = renderToStaticMarkup(await draw());
    expect(html).toContain(`afterId=${id(199)}`); expect(html).toContain("Next drafts");
    expect(m.list).toHaveBeenLastCalledWith({ userId, datasetId, limit: 1, variant: "draft", afterId: id(199) });
    m.list.mockResolvedValueOnce([{ id: id(200), type: "partnerStories", nativeId: "drafts.last" }]);
    const last = renderToStaticMarkup(await draw({ afterId: id(199) }));
    expect(m.list).toHaveBeenLastCalledWith({ userId, datasetId, limit: 100, variant: "draft", afterId: id(199) });
    expect(last).toContain("drafts.last"); expect(last).toContain("First page"); expect(last).not.toContain("Next drafts");
    m.list.mockResolvedValueOnce(rows).mockResolvedValueOnce([]);
    expect(renderToStaticMarkup(await draw())).not.toContain("Next drafts");
  });
});