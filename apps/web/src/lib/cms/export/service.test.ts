import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: m.getDb }));
import { CMS_EXPORT_AUDIT_ACTION, exportCmsDatasetNdjson } from "./service";
import { CmsNdjsonError, parseNdjson, verifyNdjson } from "./ndjson";

const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const actorId = id(1), ownerId = id(2), datasetId = id(3), orgId = id(4), otherDataset = id(9);
const PRIVATE = "PRIVATE_EVIDENCE";

type Row = Record<string, any>;
function matches(row: Row, where: Row | undefined): boolean {
  return Object.entries(where ?? {}).every(([key, expected]: [string, any]) => {
    if (expected !== null && typeof expected === "object") {
      if ("in" in expected) return expected.in.includes(row[key]);
      if ("not" in expected) return row[key] !== expected.not;
    }
    return row[key] === expected;
  });
}
function project(row: Row | undefined, select: Row | undefined): any {
  if (!row) return null;
  if (!select) return structuredClone(row);
  return Object.fromEntries(Object.entries(select).map(([key, rule]: [string, any]) => [key,
    rule === true ? structuredClone(row[key]) : Array.isArray(row[key])
      ? row[key].filter((item: Row) => matches(item, rule.where)).map((item: Row) => project(item, rule.select))
      : project(row[key], rule.select)]));
}
function doc(n: number, nativeId: string, type: string, variant: "draft" | "published", payload: Row = {}, over: Row = {}) {
  const documentId = id(100 + n), revisionId = id(200 + n);
  return {
    document: { id: documentId, datasetId, nativeId, type, variant, currentRevisionId: revisionId, archivedAt: null,
      createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-02T00:00:00Z"), ...over },
    revision: { id: revisionId, datasetId, documentId, nativeRev: `native-rev-${n}`, payload: { _id: nativeId, _type: type, ...payload } }
  };
}
const story = (extra: Row = {}) => ({ company: "Co", personName: "P", role: "R", quote: "Q", tone: "lime", ...extra });

let state: { user: Row[]; cmsDataset: Row[]; cmsDocument: Row[]; cmsRevision: Row[]; auditLog: Row[] };
let trace: Array<{ name: string; query: any }>;
let transactionOptions: any[];
let transactions: number;
let beforeTransaction: ((n: number) => void) | undefined;
let failure: string | undefined;

function seed(rows: Array<ReturnType<typeof doc>>) {
  state.cmsDocument = rows.map((r) => r.document);
  state.cmsRevision = rows.map((r) => r.revision);
}
function standardRows() {
  return [
    doc(1, "pub", "partnerStories", "published", story({ consent: { status: "approved", evidence: PRIVATE } })),
    doc(2, "drafts.pub", "partnerStories", "draft", story({ quote: "DRAFT Q", consent: { status: "pending", evidence: PRIVATE } })),
    doc(3, "drafts.only", "partnerStories", "draft", story({ quote: "ONLY DRAFT" })),
    doc(4, "settings", "siteSettings", "published", { title: "Site", mux: { apiKey: "SECRET_API", playbackId: "ok" } }),
    doc(5, "mux-key", "mux.apiKey", "published", { apiKey: "SECRET_DOC" })
  ];
}
function grant(role: string | null) {
  state.cmsDataset[0].grants = role ? [{ datasetId, userId: actorId, role, revokedAt: null }] : [];
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("JONGO_CMS_ENABLED", "true");
  vi.stubEnv("JONGO_CMS_WRITES_ENABLED", "false");
  trace = []; transactionOptions = []; transactions = 0; beforeTransaction = undefined; failure = undefined;
  state = {
    user: [{ id: actorId, deletedAt: null }],
    cmsDataset: [{ id: datasetId, organizationId: orgId, siteId: null, archivedAt: null,
      organization: { id: orgId, ownerId, deletedAt: null,
        owner: { id: ownerId, deletedAt: null, subscriptionPlanId: "enterprise-sla", subscriptionStatus: "active",
          subscriptionCurrentPeriodEnd: new Date("2999-01-01T00:00:00Z") },
        collaborators: [{ organizationId: orgId, userId: actorId, role: "collaborator", deletedAt: null }] },
      site: null, grants: [{ datasetId, userId: actorId, role: "editor", revokedAt: null }] }],
    cmsDocument: [], cmsRevision: [], auditLog: []
  };
  seed(standardRows());
  m.getDb.mockImplementation(async () => {
    const call = (name: string, query: any) => {
      trace.push({ name, query });
      if (failure === name) throw new Error("SQL PRIVATE_PAYLOAD password=SECRET");
    };
    const delegate = (model: "user" | "cmsDataset" | "cmsDocument" | "cmsRevision") => ({
      findUnique: async (q: any) => { call(`${model}.findUnique`, q); return project(state[model].find((r) => matches(r, q.where)), q.select); },
      findMany: async (q: any) => {
        call(`${model}.findMany`, q);
        return state[model].filter((r) => matches(r, q.where)).sort((a, b) => String(a.id).localeCompare(String(b.id)))
          .slice(0, q.take).map((r) => project(r, q.select));
      }
    });
    return {
      $transaction: async (callback: any, options: any) => {
        transactions++; transactionOptions.push(options);
        beforeTransaction?.(transactions);
        const snapshot = structuredClone(state.auditLog);
        try {
          return await callback({
            user: delegate("user"), cmsDataset: delegate("cmsDataset"), cmsDocument: delegate("cmsDocument"), cmsRevision: delegate("cmsRevision"),
            auditLog: { create: async (q: any) => { call("auditLog.create", q); state.auditLog.push(structuredClone(q.data)); return q.data; } }
          });
        } catch (error) { state.auditLog = snapshot; throw error; }
      }
    };
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

const base = { userId: actorId, datasetId };
const ids = async (input: Row = {}) => parseNdjson((await exportCmsDatasetNdjson({ ...base, ...input } as any)).ndjson).documents.map((d) => d._id);
async function code(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (e) => e);
  expect(error).toBeInstanceOf(CmsNdjsonError);
  expect(error.message).not.toMatch(/PRIVATE_PAYLOAD|SECRET|password/);
  return error.code as string;
}
const loaded = () => trace.some((t) => t.name === "cmsDocument.findMany");

describe("exportCmsDatasetNdjson authorization", () => {
  it("readers export published, non-private data only", async () => {
    grant("reader");
    const out = await exportCmsDatasetNdjson(base);
    const text = out.ndjson.toString("utf8");
    expect(parseNdjson(out.ndjson).documents.map((d) => d._id)).toEqual(["pub"]);
    expect(text).not.toContain(PRIVATE);
    expect(text).not.toContain("SECRET_");
    expect(out.manifest).toMatchObject({ perspective: "published", includePrivate: false, documentCount: 1 });
    // The reader never even loads draft rows.
    expect(trace.filter((t) => t.name === "cmsDocument.findMany").every((t) => t.query.where.variant === "published")).toBe(true);
    for (const input of [{ perspective: "previewDrafts" }, { perspective: "raw" }, { includePrivate: true }, { perspective: "raw", includePrivate: true }]) {
      expect(await code(exportCmsDatasetNdjson({ ...base, ...input } as any))).toBe("denied");
    }
  });
  it("editors export drafts and raw, still without private data", async () => {
    expect(await ids({ perspective: "raw" })).toEqual(["drafts.only", "pub", "drafts.pub"]);
    expect(await ids({ perspective: "previewDrafts" })).toEqual(["only", "pub"]);
    const raw = (await exportCmsDatasetNdjson({ ...base, perspective: "raw" })).ndjson.toString("utf8");
    expect(raw).not.toContain(PRIVATE);
    expect(await code(exportCmsDatasetNdjson({ ...base, includePrivate: true }))).toBe("denied");
    expect(await code(exportCmsDatasetNdjson({ ...base, perspective: "raw", includePrivate: true }))).toBe("denied");
  });
  it("only dataset admins can include private fields, and secrets are still never exported", async () => {
    grant("admin");
    const out = await exportCmsDatasetNdjson({ ...base, perspective: "raw", includePrivate: true });
    const text = out.ndjson.toString("utf8");
    expect(text).toContain(PRIVATE);
    expect(text).toContain("playbackId");
    for (const secret of ["SECRET_API", "SECRET_DOC", "apiKey", "mux-key"]) expect(text).not.toContain(secret);
    expect(out.manifest).toMatchObject({ includePrivate: true, redactedSecretKeyCount: 1, omitted: { excludedType: 1, unregisteredType: 0 } });
    expect(verifyNdjson(out.ndjson, out.manifest)).toEqual({ ok: true });
    // publisher is not enough
    grant("publisher");
    expect(await code(exportCmsDatasetNdjson({ ...base, includePrivate: true }))).toBe("denied");
  });
  it("a tenant admin (organization role) counts as dataset admin", async () => {
    grant("reader");
    state.cmsDataset[0].organization.collaborators[0].role = "admin";
    expect((await exportCmsDatasetNdjson({ ...base, perspective: "raw", includePrivate: true })).manifest.includePrivate).toBe(true);
  });
  it("a lapsed authoring sponsor does not block export (reads and exports survive downgrade)", async () => {
    state.cmsDataset[0].organization.owner.subscriptionStatus = "canceled";
    expect(await ids({ perspective: "raw" })).toEqual(["drafts.only", "pub", "drafts.pub"]);
  });
  it.each([
    ["feature flag disabled", () => vi.stubEnv("JONGO_CMS_ENABLED", "false")],
    ["flag unset", () => vi.stubEnv("JONGO_CMS_ENABLED", "")],
    ["no grant and no membership", () => { grant(null); state.cmsDataset[0].organization.collaborators = []; }],
    ["grant without live tenant membership", () => { state.cmsDataset[0].organization.collaborators = []; }],
    ["unknown grant role", () => grant("superuser")],
    ["deleted actor", () => { state.user[0].deletedAt = new Date(); }],
    ["archived dataset", () => { state.cmsDataset[0].archivedAt = new Date(); }]
  ])("denies: %s", async (_name, arrange) => {
    arrange();
    expect(await code(exportCmsDatasetNdjson(base))).toBe("denied");
    expect(loaded()).toBe(false);
    expect(state.auditLog).toEqual([]);
  });
  it("denies another dataset and malformed identifiers without loading documents", async () => {
    expect(await code(exportCmsDatasetNdjson({ userId: actorId, datasetId: otherDataset }))).toBe("denied");
    expect(await code(exportCmsDatasetNdjson({ userId: "not-a-uuid", datasetId }))).toBe("denied");
    expect(await code(exportCmsDatasetNdjson({ userId: actorId, datasetId: "x" }))).toBe("denied");
    expect(await code(exportCmsDatasetNdjson({ userId: undefined as never, datasetId }))).toBe("denied");
    expect(await code(exportCmsDatasetNdjson(undefined as never))).toBe("denied");
    expect(loaded()).toBe(false);
  });
  it("a revoked grant falls back to published-only for tenant collaborators, never drafts or private", async () => {
    state.cmsDataset[0].grants[0].revokedAt = new Date();
    expect(await ids()).toEqual(["pub"]);
    expect(await code(exportCmsDatasetNdjson({ ...base, perspective: "raw" }))).toBe("denied");
  });
  it("reauthorizes inside the read snapshot: a role downgrade after the capability check denies", async () => {
    beforeTransaction = (n) => { if (n === 2) grant("reader"); };
    expect(await code(exportCmsDatasetNdjson({ ...base, perspective: "raw" }))).toBe("denied");
    expect(loaded()).toBe(false);
    expect(state.auditLog).toEqual([]);
  });
  it("never exports another dataset's or archived documents", async () => {
    seed([...standardRows(), doc(7, "foreign", "partnerStories", "published", story(), { datasetId: otherDataset }),
      doc(8, "archived", "partnerStories", "published", story(), { archivedAt: new Date() }),
      doc(9, "nopointer", "partnerStories", "published", story(), { currentRevisionId: null })]);
    expect(await ids({ perspective: "raw" })).toEqual(["drafts.only", "pub", "drafts.pub"]);
    expect(trace.find((t) => t.name === "cmsDocument.findMany")!.query.where).toMatchObject({ datasetId, archivedAt: null });
  });
});

describe("exportCmsDatasetNdjson behavior", () => {
  it("reads in a RepeatableRead snapshot, needs no write flag, and writes exactly one audit row", async () => {
    vi.stubEnv("JONGO_CMS_WRITES_ENABLED", "");
    vi.setSystemTime(new Date("2026-11-04T12:00:00.000Z"));
    const out = await exportCmsDatasetNdjson({ ...base, perspective: "raw" });
    expect(transactionOptions.every((o) => o.isolationLevel === "RepeatableRead")).toBe(true);
    expect(trace.filter((t) => /\.(create|update|updateMany|delete)$/.test(t.name)).map((t) => t.name)).toEqual(["auditLog.create"]);
    expect(out.manifest.exportedAt).toBe(new Date().toISOString());
    expect(state.auditLog).toEqual([{
      organizationId: orgId, actorId, action: CMS_EXPORT_AUDIT_ACTION, resourceType: "cms_dataset", resourceId: datasetId,
      details: { datasetId, perspective: "raw", includePrivate: false, documentCount: 3, byteLength: out.manifest.byteLength,
        sha256: out.manifest.sha256, omitted: { excludedType: 1, unregisteredType: 1 }, redactedSecretKeyCount: 0 }
    }]);
    // Audit carries counts and a hash, never document content.
    const audit = JSON.stringify(state.auditLog);
    for (const content of [PRIVATE, "DRAFT Q", "ONLY DRAFT", "company", "SECRET_"]) expect(audit).not.toContain(content);
  });
  it("returns bytes that match their manifest and re-import cleanly", async () => {
    const { ndjson, manifest } = await exportCmsDatasetNdjson({ ...base, perspective: "raw" });
    expect(verifyNdjson(ndjson, manifest)).toEqual({ ok: true });
    expect(manifest.counts.byVariant).toEqual({ published: 1, draft: 2, version: 0 });
  });
  it("fills envelope metadata from the row when the payload lacks it", async () => {
    seed([doc(1, "bare", "partnerStories", "published", story())]);
    const [row] = parseNdjson((await exportCmsDatasetNdjson(base)).ndjson).documents;
    expect(row).toMatchObject({ _id: "bare", _type: "partnerStories", _rev: "native-rev-1",
      _createdAt: "2026-01-01T00:00:00.000Z", _updatedAt: "2026-01-02T00:00:00.000Z" });
  });
  it("returns a typed error instead of truncating an oversized dataset", async () => {
    expect(await code(exportCmsDatasetNdjson({ ...base, perspective: "raw", limits: { maxDocuments: 4 } }))).toBe("dataset_too_large");
    expect((await exportCmsDatasetNdjson({ ...base, perspective: "raw", limits: { maxDocuments: 5 } })).manifest.documentCount).toBe(3);
    expect(state.auditLog).toHaveLength(1);
  });
  it("loads revisions in bounded chunks for large datasets", async () => {
    seed(Array.from({ length: 250 }, (_, n) => doc(n + 1, `d${n}`, "partnerStories", "published", story())));
    expect((await exportCmsDatasetNdjson(base)).manifest.documentCount).toBe(250);
    const revisionQueries = trace.filter((t) => t.name === "cmsRevision.findMany");
    expect(revisionQueries).toHaveLength(3);
    expect(revisionQueries.every((t) => t.query.where.datasetId === datasetId && t.query.where.id.in.length <= 100)).toBe(true);
  });
  it("does not write an audit row when serialization fails", async () => {
    expect(await code(exportCmsDatasetNdjson({ ...base, perspective: "raw", limits: { maxLineBytes: 20 } }))).toBe("line_too_large");
    expect(state.auditLog).toEqual([]);
  });
  it("fails the export when the audit row cannot be written", async () => {
    failure = "auditLog.create";
    expect(await code(exportCmsDatasetNdjson(base))).toBe("unavailable");
    expect(state.auditLog).toEqual([]);
  });
  it.each([
    ["missing revision", (r: ReturnType<typeof standardRows>) => { r[0].document.currentRevisionId = id(999); }],
    ["revision of another document", (r: ReturnType<typeof standardRows>) => { r[0].revision.documentId = id(998); }],
    ["revision of another dataset", (r: ReturnType<typeof standardRows>) => { r[0].revision.datasetId = otherDataset; }],
    ["non-object payload", (r: ReturnType<typeof standardRows>) => { (r[0].revision as any).payload = ["x"]; }]
  ])("fails closed on inconsistent storage: %s", async (_name, corrupt) => {
    const rows = standardRows(); corrupt(rows); seed(rows);
    expect(await code(exportCmsDatasetNdjson(base))).toBe("unavailable");
    expect(state.auditLog).toEqual([]);
  });
  it("hides database errors", async () => {
    failure = "cmsDocument.findMany";
    expect(await code(exportCmsDatasetNdjson(base))).toBe("unavailable");
  });
  it("fails closed when the database is not configured", async () => {
    m.getDb.mockResolvedValue(null);
    expect(await code(exportCmsDatasetNdjson(base))).toBe("denied");
  });
  it("rejects bad options before any database access", async () => {
    expect(await code(exportCmsDatasetNdjson({ ...base, perspective: "bogus" as never }))).toBe("invalid_perspective");
    expect(await code(exportCmsDatasetNdjson({ ...base, includePrivate: "true" as never }))).toBe("invalid_options");
    expect(await code(exportCmsDatasetNdjson({ ...base, limits: { maxDocuments: 0 } }))).toBe("invalid_options");
    expect(m.getDb).not.toHaveBeenCalled();
  });
});
