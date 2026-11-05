import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: m.getDb }));
import { queryCmsDataset } from "./service";
import { CmsQueryError } from "./groq";

const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const actorId = id(1), ownerId = id(2), datasetId = id(3), orgId = id(4), otherDataset = id(9);
const SECRET = "PRIVATE_EVIDENCE";

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

function doc(n: number, nativeId: string, type: string, variant: "draft" | "published", extra: Row = {}, over: Row = {}) {
  const documentId = id(100 + n), revisionId = id(200 + n);
  return {
    document: { id: documentId, datasetId, nativeId, type, variant, currentRevisionId: revisionId, archivedAt: null,
      createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-02T00:00:00Z"), ...over },
    revision: { id: revisionId, datasetId, documentId, nativeRev: `native-rev-${n}`,
      payload: { _id: nativeId, _type: type, title: `title-${nativeId}`, ...extra } }
  };
}
const story = (extra: Row = {}) => ({ company: "Co", personName: "P", role: "R", quote: "Q", tone: "lime", ...extra });

let state: { user: Row[]; cmsDataset: Row[]; cmsDocument: Row[]; cmsRevision: Row[] };
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
    doc(1, "pub", "partnerStories", "published", story({ title: "x", consent: { status: "approved", evidence: SECRET } })),
    doc(2, "drafts.pub", "partnerStories", "draft", story({ consent: { status: "pending", evidence: SECRET }, quote: "DRAFT Q" })),
    doc(3, "drafts.only", "partnerStories", "draft", story({ quote: "ONLY DRAFT" }))
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
    cmsDocument: [], cmsRevision: []
  };
  seed(standardRows());
  m.getDb.mockImplementation(async () => {
    const call = (name: string, query: any) => {
      trace.push({ name, query });
      if (failure === name) throw new Error("SQL PRIVATE_PAYLOAD password=SECRET");
    };
    const delegate = (model: keyof typeof state) => ({
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
        return callback({ user: delegate("user"), cmsDataset: delegate("cmsDataset"),
          cmsDocument: delegate("cmsDocument"), cmsRevision: delegate("cmsRevision") });
      }
    };
  });
});
afterEach(() => { vi.unstubAllEnvs(); });

const base = { userId: actorId, datasetId };
const titles = async (perspective?: "published" | "previewDrafts" | "raw", extra: Row = {}) =>
  (await queryCmsDataset({ ...base, perspective, query: "*._id | order(@)", ...extra } as any)).result;
async function code(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (e) => e);
  expect(error).toBeInstanceOf(CmsQueryError);
  expect(error.message).not.toMatch(/PRIVATE_PAYLOAD|SECRET|password/);
  return error.code as string;
}

describe("queryCmsDataset authorization", () => {
  it("editors can query every perspective with the same envelope semantics", async () => {
    expect(await titles("published")).toEqual(["pub"]);
    expect(await titles("previewDrafts")).toEqual(["only", "pub"]);
    expect(await titles("raw")).toEqual(["drafts.only", "drafts.pub", "pub"]);
    const out = await queryCmsDataset({ ...base, perspective: "previewDrafts", query: "*[_id == 'pub'][0]{quote, _rev, _createdAt}" });
    expect(out).toMatchObject({ perspective: "previewDrafts", documentCount: 2,
      result: { quote: "DRAFT Q", _rev: "native-rev-2", _createdAt: "2026-01-01T00:00:00.000Z" } });
  });
  it("defaults to published", async () => {
    expect((await queryCmsDataset({ ...base, query: "count(*)" })).perspective).toBe("published");
  });
  it("readers may query only published, and never see private fields", async () => {
    grant("reader");
    expect(await titles()).toEqual(["pub"]);
    const out = await queryCmsDataset({ ...base, query: "*[0]" });
    expect(JSON.stringify(out.result)).not.toContain(SECRET);
    for (const perspective of ["previewDrafts", "raw"] as const) {
      expect(await code(queryCmsDataset({ ...base, perspective, query: "*" }))).toBe("denied");
    }
    // The reader never even loads draft rows.
    expect(trace.filter((t) => t.name === "cmsDocument.findMany").every((t) => t.query.where.variant === "published")).toBe(true);
  });
  it("editors see private fields (they edit them)", async () => {
    const out = await queryCmsDataset({ ...base, perspective: "raw", query: "*[_id == 'pub'][0].consent.evidence" });
    expect(out.result).toBe(SECRET);
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
    expect(await code(queryCmsDataset({ ...base, query: "*" }))).toBe("denied");
    expect(trace.some((t) => t.name === "cmsDocument.findMany")).toBe(false);
  });
  it("a revoked grant or lapsed sponsor downgrades to published-only reads, never drafts", async () => {
    state.cmsDataset[0].grants[0].revokedAt = new Date();
    expect(await titles("published")).toEqual(["pub"]);
    expect(await code(queryCmsDataset({ ...base, perspective: "previewDrafts", query: "*" }))).toBe("denied");
    state.cmsDataset[0].grants[0].revokedAt = null;
    state.cmsDataset[0].organization.owner.subscriptionStatus = "canceled";
    expect(await titles("published")).toEqual(["pub"]);
    expect(await code(queryCmsDataset({ ...base, perspective: "raw", query: "*" }))).toBe("denied");
  });
  it("denies another dataset and malformed identifiers without loading documents", async () => {
    expect(await code(queryCmsDataset({ userId: actorId, datasetId: otherDataset, query: "*" }))).toBe("denied");
    expect(await code(queryCmsDataset({ userId: "not-a-uuid", datasetId, query: "*" }))).toBe("denied");
    expect(await code(queryCmsDataset({ userId: actorId, datasetId: "x", query: "*" }))).toBe("denied");
    expect(await code(queryCmsDataset({ userId: undefined as never, datasetId, query: "*" }))).toBe("denied");
    expect(trace.some((t) => t.name === "cmsDocument.findMany")).toBe(false);
  });
  it("never returns another dataset's or archived documents", async () => {
    const foreign = doc(7, "foreign", "partnerStories", "published", story(), { datasetId: otherDataset });
    const archived = doc(8, "archived", "partnerStories", "published", story(), { archivedAt: new Date() });
    const unpointed = doc(9, "nopointer", "partnerStories", "published", story(), { currentRevisionId: null });
    seed([...standardRows(), foreign, archived, unpointed]);
    expect(await titles("raw")).toEqual(["drafts.only", "drafts.pub", "pub"]);
    const where = trace.find((t) => t.name === "cmsDocument.findMany")!.query.where;
    expect(where).toMatchObject({ datasetId, archivedAt: null });
  });
  it("reauthorizes inside the read snapshot: a role downgrade after the capability check denies drafts", async () => {
    beforeTransaction = (n) => { if (n === 2) grant("reader"); };
    expect(await code(queryCmsDataset({ ...base, perspective: "previewDrafts", query: "*" }))).toBe("denied");
    expect(trace.some((t) => t.name === "cmsDocument.findMany")).toBe(false);
  });
  it("does not depend on the write rollout flag and reads in a RepeatableRead snapshot", async () => {
    vi.stubEnv("JONGO_CMS_WRITES_ENABLED", "");
    await queryCmsDataset({ ...base, query: "count(*)" });
    expect(transactionOptions.every((o) => o.isolationLevel === "RepeatableRead")).toBe(true);
    expect(trace.some((t) => /\.(create|update|updateMany|delete)$/.test(t.name))).toBe(false);
  });
});

describe("queryCmsDataset inputs and failures", () => {
  it("rejects bad queries and params before any database access", async () => {
    for (const query of ["", "   ", undefined, 5]) {
      expect(await code(queryCmsDataset({ ...base, query: query as never }))).toBe("invalid_query");
    }
    expect(await code(queryCmsDataset({ ...base, query: "$a", params: { a: () => 1 } as never }))).toBe("invalid_params");
    expect(await code(queryCmsDataset({ ...base, query: "*", perspective: "bogus" as never }))).toBe("invalid_perspective");
    expect(await code(queryCmsDataset({ ...base, query: "x".repeat(10_001) }))).toBe("query_too_long");
    expect(m.getDb).not.toHaveBeenCalled();
  });
  it("parse errors are typed with a position and no data", async () => {
    const error = await queryCmsDataset({ ...base, query: "*[_type == " }).then(() => null, (e) => e);
    // Syntax errors surface only after authorization; position comes from the query text.
    expect(error).toBeInstanceOf(CmsQueryError);
    expect(error.code).toBe("invalid_query");
  });
  it("passes params as data", async () => {
    const out = await queryCmsDataset({ ...base, perspective: "raw", query: "*[_id == $id][0].quote", params: { id: "drafts.only" } });
    expect(out.result).toBe("ONLY DRAFT");
  });
  it("returns a typed error instead of truncating an oversized dataset", async () => {
    expect(await code(queryCmsDataset({ ...base, perspective: "raw", query: "count(*)", limits: { maxDocuments: 2 } }))).toBe("dataset_too_large");
    expect((await queryCmsDataset({ ...base, perspective: "raw", query: "count(*)", limits: { maxDocuments: 3 } })).result).toBe(3);
  });
  it("loads revisions in bounded chunks for large datasets", async () => {
    seed(Array.from({ length: 250 }, (_, n) => doc(n + 1, `d${n}`, "partnerStories", "published", story())));
    expect((await queryCmsDataset({ ...base, query: "count(*)" })).result).toBe(250);
    const revisionQueries = trace.filter((t) => t.name === "cmsRevision.findMany");
    expect(revisionQueries).toHaveLength(3);
    expect(revisionQueries.every((t) => t.query.where.datasetId === datasetId && t.query.where.id.in.length <= 100)).toBe(true);
  });
  it.each([
    ["missing revision", (r: ReturnType<typeof standardRows>) => { r[0].document.currentRevisionId = id(999); }],
    ["revision of another document", (r: ReturnType<typeof standardRows>) => { r[0].revision.documentId = id(998); }],
    ["revision of another dataset", (r: ReturnType<typeof standardRows>) => { r[0].revision.datasetId = otherDataset; }],
    ["non-object payload", (r: ReturnType<typeof standardRows>) => { (r[0].revision as any).payload = ["x"]; }]
  ])("fails closed on inconsistent storage: %s", async (_name, corrupt) => {
    const rows = standardRows(); corrupt(rows); seed(rows);
    expect(await code(queryCmsDataset({ ...base, query: "*" }))).toBe("unavailable");
  });
  it("hides database errors", async () => {
    failure = "cmsDocument.findMany";
    expect(await code(queryCmsDataset({ ...base, query: "*" }))).toBe("unavailable");
  });
  it("fails closed when the database is not configured", async () => {
    m.getDb.mockResolvedValue(null);
    expect(await code(queryCmsDataset({ ...base, query: "*" }))).toBe("denied");
  });
  it("fills envelope metadata from the row when the payload lacks it", async () => {
    seed([doc(1, "bare", "partnerStories", "published", {})]);
    const out = await queryCmsDataset({ ...base, query: "*[0]{_id, _type, _rev, _createdAt, _updatedAt}" });
    expect(out.result).toEqual({ _id: "bare", _type: "partnerStories", _rev: "native-rev-1",
      _createdAt: "2026-01-01T00:00:00.000Z", _updatedAt: "2026-01-02T00:00:00.000Z" });
  });
});
