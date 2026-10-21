import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const m = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: m.getDb }));
vi.mock("./schemas", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./schemas")>();
  return { ...actual, cmsSchemaRegistry: { ...actual.cmsSchemaRegistry, get: vi.fn(actual.cmsSchemaRegistry.get) } };
});
import { cmsSchemaRegistry, cmsSchemas } from "./schemas";
import { createSchemaRegistry } from "./schema";
import { getCmsDocument, listCmsDocuments, saveCmsDraft, saveCmsDraftForm, withCmsWriteTransaction, CmsDocumentError, type SaveCmsDraftInput } from "./documents";
import { cmsFormValues } from "./form";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const actorId = id(1), ownerId = id(2), datasetId = id(3), orgId = id(4), siteId = id(5);
const now = new Date("2026-10-19T12:00:00.000Z");
const scope = { userId: actorId, datasetId };
function content() {
  return { _id: "drafts.case.hello", _type: "partnerStories", _rev: "SOURCE_NOT_NATIVE_CAS",
    _createdAt: "2020-01-01T01:02:03.000Z", _updatedAt: "2021-02-03T01:02:03Z",
    company: "Example", personName: "Person", role: "Partner", quote: "Private draft quote.",
    tone: "lime", textBadge: "Example", consent: { status: "pending", quote: false,
      likeness: false, evidence: "PRIVATE_CONSENT_EVIDENCE" } };
}
const request = (overrides: Partial<SaveCmsDraftInput> = {}): SaveCmsDraftInput => ({ ...scope,
  sourceId: "drafts.case.hello", input: content(), mutationId: "retry-1", ...overrides });

function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([key, expected]: [string, any]) => {
    if (key === "datasetId_key") return matches(row, expected);
    if (expected !== null && typeof expected === "object") {
      if ("gt" in expected) return row[key] > expected.gt;
      if ("in" in expected) return expected.in.includes(row[key]);
    }
    return row[key] === expected;
  });
}
function project(row: any, select: any): any {
  if (!row) return null;
  if (!select) return structuredClone(row);
  return Object.fromEntries(Object.entries(select).map(([key, rule]: [string, any]) => [key,
    rule === true ? structuredClone(row[key]) : Array.isArray(row[key])
      ? row[key].filter((item: any) => matches(item, rule.where)).map((item: any) => project(item, rule.select))
      : project(row[key], rule.select)]));
}
function fixture() {
  return {
    user: [{ id: actorId, deletedAt: null, role: "super_admin" }],
    cmsDataset: [{ id: datasetId, organizationId: orgId, siteId, archivedAt: null,
      organization: { id: orgId, ownerId, deletedAt: null,
        owner: { id: ownerId, deletedAt: null, subscriptionPlanId: "enterprise-sla",
          subscriptionStatus: "active", subscriptionCurrentPeriodEnd: new Date("2027-01-01T00:00:00Z"),
          stripeCustomerId: "PRIVATE_CUSTOMER" },
        collaborators: [{ organizationId: orgId, userId: actorId, role: "collaborator", deletedAt: null }] },
      site: { id: siteId, organizationId: orgId, deletedAt: null, collaborators: [] as any[] },
      grants: [{ datasetId, userId: actorId, role: "editor", revokedAt: null }] }],
    cmsDocument: [] as any[], cmsRevision: [] as any[], cmsMutation: [] as any[],
    cmsReference: [] as any[], auditLog: [] as any[]
  };
}
let state: ReturnType<typeof fixture>;
let failure: string | undefined;
let casMiss: boolean;
let beforeCallback: (() => void) | undefined;
let attempts: number;
let injectedCode: string | undefined;
let trace: Array<{ name: string; query: any }>;
let transactionOptions: any[];
let queue: Promise<unknown>;
let duringLock: ((sql: string, working: ReturnType<typeof fixture>) => void) | undefined;

// In-memory transaction model: work on a detached snapshot, commit only after
// callback success. Real where/select evaluation catches scope and DTO leaks.
// Serialized callbacks model the dataset lock, NOT PostgreSQL concurrency proof.
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(cmsSchemaRegistry.get).mockImplementation(createSchemaRegistry(cmsSchemas).get);
  vi.useFakeTimers(); vi.setSystemTime(now);
  vi.stubEnv("JONGO_CMS_ENABLED", "true");
  vi.stubEnv("JONGO_CMS_WRITES_ENABLED", "true");
  state = fixture(); failure = undefined; casMiss = false; beforeCallback = undefined;
  attempts = 0; injectedCode = undefined; trace = []; transactionOptions = []; queue = Promise.resolve();
  duringLock = undefined;
  m.getDb.mockResolvedValue({
    user: { findUnique: async (q: any) => {
      trace.push({ name: "preliminary.user.findUnique", query: q });
      return project(state.user.find((row) => matches(row, q.where)), q.select);
    } },
    cmsDataset: { findUnique: async (q: any) => {
      trace.push({ name: "preliminary.cmsDataset.findUnique", query: q });
      return project(state.cmsDataset.find((row) => matches(row, q.where)), q.select);
    } },
    $transaction: (callback: any, options: any) => {
    transactionOptions.push(options);
    const run = queue.then(async () => {
      attempts++;
      beforeCallback?.();
      const working = structuredClone(state);
      const tx: any = {};
      const call = (name: string, query: any) => {
        trace.push({ name, query });
        if (failure === name) throw new Error("SQL PRIVATE_PAYLOAD password=SECRET");
      };
      tx.$executeRaw = async (strings: TemplateStringsArray, ...values: any[]) => {
        call("executeRaw", { sql: strings.join("?"), values }); return 0;
      };
      tx.$queryRaw = async (strings: TemplateStringsArray, ...values: any[]) => {
        const sql = strings.join("?");
        call("queryRaw", { sql, values });
        duringLock?.(sql, working);
        return [{ id: datasetId }];
      };
      for (const [model, rows] of Object.entries(working)) {
        tx[model] = {
          findUnique: async (q: any) => { call(`${model}.findUnique`, q); return project(rows.find((row) => matches(row, q.where)), q.select); },
          findFirst: async (q: any) => {
            call(`${model}.findFirst`, q);
            let found = rows.filter((row) => matches(row, q.where));
            if (q.orderBy?.sequence) found = found.sort((a, b) => b.sequence - a.sequence);
            return project(found[0], q.select);
          },
          findMany: async (q: any) => { call(`${model}.findMany`, q);
            return rows.filter((row) => matches(row, q.where)).sort((a, b) => a.id.localeCompare(b.id))
              .slice(0, q.take).map((row) => project(row, q.select)); },
          create: async (q: any) => {
            call(`${model}.create`, q);
            if (model === "cmsMutation" && rows.some((row) => row.datasetId === q.data.datasetId && row.key === q.data.key)) throw { code: "P2002" };
            const row = { archivedAt: null, slug: null, locale: null, ...structuredClone(q.data) };
            rows.push(row); return project(row, q.select);
          },
          updateMany: async (q: any) => {
            call(`${model}.updateMany`, q);
            if (casMiss) return { count: 0 };
            const found = rows.filter((row) => matches(row, q.where));
            for (const row of found) Object.assign(row, q.data, { lockVersion: row.lockVersion + q.data.lockVersion.increment });
            return { count: found.length };
          }
        };
      }
      const result = await callback(tx);
      if (injectedCode) { const code = injectedCode; injectedCode = undefined; throw { code }; }
      state = working;
      return result;
    });
    queue = run.catch(() => {});
    return run;
  } });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const dataset = () => state.cmsDataset[0];
const writes = () => trace.filter((entry) => /\.(create|updateMany)$/.test(entry.name));
async function rejected(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ name: "CmsDocumentError", code, message: `CMS document operation ${code}.` });
}

describe("private scoped CMS reads", () => {
  it("paginates over 100 drafts after DB variant filtering, never truncating mixed variants", async () => {
    await saveCmsDraft(request());
    const base = state.cmsDocument[0];
    state.cmsDocument = Array.from({ length: 310 }, (_, n) => ({ ...base, id: id(100 + n),
      nativeId: `${n % 2 ? "drafts." : ""}${n}`, variant: n % 2 ? "draft" : "published" }));
    state.cmsDocument.push({ ...base, id: id(999), datasetId: id(90) });
    const first = await listCmsDocuments({ ...scope, variant: "draft", limit: 100 });
    const second = await listCmsDocuments({ ...scope, variant: "draft", limit: 100, afterId: first.at(-1)!.id });
    expect(first).toHaveLength(100); expect(second).toHaveLength(55);
    expect(new Set([...first, ...second].map(row => row.id)).size).toBe(155);
    expect([...first, ...second].every(row => row.variant === "draft" && row.datasetId === datasetId)).toBe(true);
    expect(trace.filter(e => e.name === "cmsDocument.findMany").every(e => e.query.where.variant === "draft")).toBe(true);
    await rejected(listCmsDocuments({ ...scope, variant: "bad" as any }), "invalid");
  });
  it.each([undefined, "false", "TRUE", "1", " true "])("keeps reads independent of write rollout %s", async (value) => {
    const saved = await saveCmsDraft(request());
    trace = [];
    vi.stubEnv("JONGO_CMS_WRITES_ENABLED", value);
    expect(await listCmsDocuments(scope)).toHaveLength(1);
    expect((await getCmsDocument({ ...scope, documentId: saved.documentId }))?.draft?.id).toBe(saved.revisionId);
    expect(writes()).toEqual([]);
    expect(trace.filter((entry) => entry.name === "queryRaw" || entry.name === "executeRaw")).toEqual([]);
  });

  it("lists bounded metadata, not payload, raw source, provenance, sponsor or consent", async () => {
    await saveCmsDraft(request());
    state.cmsDocument.push({ ...state.cmsDocument[0], id: id(50), datasetId: id(90) });
    const rows = await listCmsDocuments({ ...scope, limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0].datasetId).toBe(datasetId);
    const encoded = JSON.stringify(rows);
    for (const secret of ["PRIVATE", "payload", "provenance", "sourceRev", "grants", "organization", "consent"]) expect(encoded).not.toContain(secret);
    const query = [...trace].reverse().find((entry) => entry.name === "cmsDocument.findMany")!.query;
    expect(query).toMatchObject({ where: { datasetId, archivedAt: null }, orderBy: { id: "asc" }, take: 1 });
    expect(query.select.currentRevision).toBeUndefined();
  });

  it.each([0, -1, 101, 1.5, NaN])("rejects unbounded/invalid page size %s", async (limit) => {
    await rejected(listCmsDocuments({ ...scope, limit }), "invalid");
    expect(m.getDb).not.toHaveBeenCalled();
  });
  it("uses stable scoped keyset pagination and registered type filters", async () => {
    expect(await listCmsDocuments({ ...scope, afterId: id(20), type: "agencyWork", limit: 100 })).toEqual([]);
    expect(trace.find((entry) => entry.name === "cmsDocument.findMany")?.query.where).toEqual({
      datasetId, archivedAt: null, id: { gt: id(20) }, type: "agencyWork"
    });
    await rejected(listCmsDocuments({ ...scope, afterId: "bad" }), "invalid");
    await rejected(listCmsDocuments({ ...scope, type: "constructor" }), "invalid");
  });
  it("reads only the exact current draft and never raw/history/source metadata", async () => {
    const saved = await saveCmsDraft(request());
    Object.assign(state.cmsRevision[0], { sourceRecordRaw: "PRIVATE_RAW", provenance: { secret: "PRIVATE_PROVENANCE" } });
    const result = await getCmsDocument({ ...scope, documentId: saved.documentId });
    expect(result?.draft?.id).toBe(saved.revisionId);
    expect(result?.draft?.payload).toEqual(content());
    expect(Object.keys(result!.draft!)).toEqual(["id", "nativeRev", "sequence", "schemaVersion", "payload"]);
    state.cmsDocument[0].datasetId = id(90);
    expect(await getCmsDocument({ ...scope, documentId: saved.documentId })).toBeNull();
    state.cmsDocument[0].datasetId = datasetId;
    state.cmsDocument[0].variant = "published";
    expect(await getCmsDocument({ ...scope, documentId: saved.documentId })).toBeNull();
  });
  it("does not follow a wrong-document or cross-dataset current pointer", async () => {
    const saved = await saveCmsDraft(request());
    state.cmsRevision[0].documentId = id(90);
    await rejected(getCmsDocument({ ...scope, documentId: saved.documentId }), "unavailable");
  });
});

describe("fresh transactional authority", () => {
  it.each([undefined, "false", "TRUE", "1", " true "])("denies direct saves and the shared export before DB access for write rollout %s", async (value) => {
    vi.stubEnv("JONGO_CMS_WRITES_ENABLED", value);
    const action = vi.fn();
    await rejected(saveCmsDraft(request()), "denied");
    await rejected(withCmsWriteTransaction(scope, action), "denied");
    expect(m.getDb).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
    expect(trace).toEqual([]);
    expect(writes()).toEqual([]);
    for (const model of ["cmsDocument", "cmsRevision", "cmsMutation", "cmsReference", "auditLog"] as const) expect(state[model]).toEqual([]);
  });
  it.each([false, true])("denies receipt replay after write rollout is disabled (after locks: %s)", async (afterLocks) => {
    await saveCmsDraft(request());
    const retained = structuredClone(state);
    trace = [];
    const disable = () => { vi.stubEnv("JONGO_CMS_WRITES_ENABLED", "false"); };
    if (afterLocks) duringLock = (sql) => { if (sql.includes('FROM "SiteCollaborator"')) disable(); };
    else beforeCallback = disable;
    await rejected(saveCmsDraft(request()), "denied");
    expect(trace.some((entry) => entry.name === "cmsMutation.findUnique")).toBe(false);
    expect(writes()).toEqual([]);
    expect(state).toEqual(retained);
    if (!afterLocks) expect(trace.filter((entry) => entry.name === "queryRaw" || entry.name === "executeRaw")).toEqual([]);
  });

  it.each(["flag", "browser", "actor", "dataset", "org", "owner", "site", "revoked", "membership", "plan", "status", "expiry", "reader"])(
    "rejects %s state and creates no receipt/revision/audit", async (kind) => {
      if (kind === "flag") vi.stubEnv("JONGO_CMS_ENABLED", "false");
      if (kind === "browser") vi.stubGlobal("window", {});
      if (kind === "actor") state.user[0].deletedAt = now as any;
      if (kind === "dataset") dataset().archivedAt = now as any;
      if (kind === "org") dataset().organization.deletedAt = now as any;
      if (kind === "owner") dataset().organization.owner.deletedAt = now as any;
      if (kind === "site") dataset().site.organizationId = id(90);
      if (kind === "revoked") dataset().grants[0].revokedAt = now as any;
      if (kind === "membership") dataset().organization.collaborators = [];
      if (kind === "plan") dataset().organization.owner.subscriptionPlanId = "pro";
      if (kind === "status") dataset().organization.owner.subscriptionStatus = "past_due";
      if (kind === "expiry") dataset().organization.owner.subscriptionCurrentPeriodEnd = now;
      if (kind === "reader") dataset().grants[0].role = "reader";
      await rejected(saveCmsDraft(request()), "denied");
      expect(writes()).toEqual([]);
      expect(trace.filter((entry) => entry.name === "queryRaw" || entry.name === "executeRaw")).toEqual([]);
    }
  );
  it("rechecks inside callback after revocation, not in a pretransaction snapshot", async () => {
    beforeCallback = () => { dataset().grants[0].revokedAt = now as any; };
    await rejected(saveCmsDraft(request()), "denied");
  });
  it.each(["grant", "sponsor"])("rereads %s after policy locks before receipt lookup", async (kind) => {
    duringLock = (sql, working) => {
      if (!sql.includes('FROM "SiteCollaborator"')) return;
      if (kind === "grant") working.cmsDataset[0].grants[0].revokedAt = now as any;
      else working.cmsDataset[0].organization.owner.subscriptionPlanId = "starter";
    };
    await rejected(saveCmsDraft(request()), "denied");
    expect(trace.some((entry) => entry.name === "cmsMutation.findUnique")).toBe(false);
    expect(writes()).toEqual([]);
  });
  it("allows a standalone owner without a grant row and skips all site locks", async () => {
    state.user[0].id = ownerId;
    dataset().grants = [];
    dataset().organization.collaborators = [];
    dataset().siteId = null as any;
    dataset().site = null as any;
    await saveCmsDraft(request({ userId: ownerId }));
    const locks = trace.filter((entry) => entry.name === "queryRaw");
    expect(locks).toHaveLength(5);
    expect(locks.some((entry) => /FROM "Site(?:Collaborator)?"/.test(entry.query.sql))).toBe(false);
    expect(locks.find((entry) => entry.query.sql.includes('FROM "CmsDatasetGrant"'))?.query.values).toEqual([datasetId, ownerId]);
  });
  it("preauthorizes without locks, then locks only scoped rows in fixed order and rereads policy", async () => {
    await saveCmsDraft(request());
    expect(trace.slice(0, 5).map((entry) => entry.name)).toEqual([
      "preliminary.user.findUnique", "preliminary.cmsDataset.findUnique", "executeRaw", "executeRaw", "queryRaw"
    ]);
    const locks = trace.filter((entry) => entry.name === "queryRaw").map((entry) => entry.query);
    expect(locks).toEqual([
      { sql: 'SELECT id FROM "CmsDataset" WHERE id = ?::uuid FOR UPDATE', values: [datasetId] },
      { sql: 'SELECT id FROM "Organization" WHERE id = ?::uuid FOR SHARE', values: [orgId] },
      { sql: 'SELECT id FROM "User" WHERE id IN (?::uuid, ?::uuid) ORDER BY id FOR SHARE', values: [actorId, ownerId] },
      { sql: 'SELECT id FROM "Collaborator" WHERE "organizationId" = ?::uuid AND "userId" = ?::uuid ORDER BY id FOR SHARE', values: [orgId, actorId] },
      { sql: 'SELECT id FROM "CmsDatasetGrant" WHERE "datasetId" = ?::uuid AND "userId" = ?::uuid ORDER BY id FOR SHARE', values: [datasetId, actorId] },
      { sql: 'SELECT id FROM "Site" WHERE id = ?::uuid FOR SHARE', values: [siteId] },
      { sql: 'SELECT id FROM "SiteCollaborator" WHERE "siteId" = ?::uuid AND "userId" = ?::uuid ORDER BY id FOR SHARE', values: [siteId, actorId] }
    ]);
    expect(trace.filter((entry) => entry.name === "executeRaw").every((entry) => !entry.query.sql.includes("LOCK TABLE"))).toBe(true);
    expect(trace.filter((entry) => entry.name === "cmsDataset.findUnique")).toHaveLength(2);
    const receiptIndex = trace.findIndex((entry) => entry.name === "cmsMutation.findUnique");
    expect(trace[receiptIndex - 1].name).toBe("cmsDataset.findUnique");
    expect(transactionOptions[0]).toEqual({ isolationLevel: "Serializable", maxWait: 3000, timeout: 10000 });
  });
  it("allows paid owner, org admin and explicitly granted site-only editors; no technical bypass", async () => {
    dataset().organization.collaborators = [];
    await rejected(saveCmsDraft(request()), "denied");
    dataset().site.collaborators = [{ siteId, userId: actorId, role: "collaborator", deletedAt: null }];
    await saveCmsDraft(request());
    dataset().siteId = null as any; dataset().site = null as any;
    await rejected(saveCmsDraft(request({ mutationId: "next" })), "denied");
    state.user[0].id = ownerId;
    await saveCmsDraft(request({ userId: ownerId, mutationId: "owner-retry", sourceId: "drafts.owner", input: { ...content(), _id: "drafts.owner" } }));
  });
  it("retains read after downgrade, denies writes and replays", async () => {
    await saveCmsDraft(request());
    dataset().organization.owner.subscriptionPlanId = "starter";
    expect(await listCmsDocuments(scope)).toHaveLength(1);
    await rejected(saveCmsDraft(request()), "denied");
  });
});

describe("validated draft identity and bounded pure JSON", () => {
  it.each(["literal \\u0000 text", "literal \\ud800 text", "literal \\uDC00 text", "paired 😀 text"])(
    "accepts representable decoded strings without matching serialized escapes: %s", async (quote) => {
      const input = { ...content(), quote };
      const saved = await saveCmsDraft(request({ input }));
      expect(state.cmsRevision[0].payload).toEqual(input);
      expect(await saveCmsDraft(request({ input }))).toEqual(saved);
    }
  );
  it.each(["\u0000", "\ud800", "\udfff", "\ud800x", "\udc00\ud800"])(
    "rejects unrepresentable code units in both keys and nested values before hashing: %j", async (bad) => {
      for (const input of [
        { ...content(), consent: { ...content().consent, evidence: bad } },
        { ...content(), consent: { ...content().consent, [bad]: "value" } }
      ]) await rejected(saveCmsDraft(request({ input })), "invalid");
      expect(m.getDb).not.toHaveBeenCalled();
      expect(writes()).toEqual([]);
    }
  );
  it.each(["unknown type", "unknown field", "private system", "wrong id", "published", "empty draft", "unsafe URL", "nul", "surrogate", "getter", "cycle", "nonfinite", "oversize", "indexed bytes"])(
    "rejects %s without persisting/quarantining content", async (kind) => {
      const input: any = content();
      const args = request({ input });
      if (kind === "unknown type") input._type = "unknown";
      if (kind === "unknown field") input.apiKey = "PRIVATE";
      if (kind === "private system") input._system = { private: true };
      if (kind === "wrong id") input._id = "drafts.other";
      if (kind === "published") args.sourceId = input._id = "published";
      if (kind === "empty draft") args.sourceId = input._id = "drafts.";
      if (kind === "unsafe URL") input.provenance = { source: "x", sourceUrl: "javascript:alert(1)" };
      if (kind === "nul") input.quote = "bad\u0000text";
      if (kind === "surrogate") input.quote = "\ud800";
      if (kind === "getter") Object.defineProperty(input, "quote", { enumerable: true, get: () => { throw Error("must not execute"); } });
      if (kind === "cycle") input.self = input;
      if (kind === "nonfinite") input.order = Infinity;
      if (kind === "oversize") input.quote = "x".repeat(600000);
      if (kind === "indexed bytes") args.sourceId = input._id = "drafts." + "界".repeat(200);
      await rejected(saveCmsDraft(args), "invalid");
      expect(writes()).toEqual([]);
    }
  );
  it("allows consent/review-pending drafts without claiming publication approval", async () => {
    const result = await saveCmsDraft(request());
    expect(state.cmsRevision[0].payload).toEqual(content());
    expect(result).not.toHaveProperty("canPublish");
    expect(state.cmsDocument[0].variant).toBe("draft");
  });
  it("preserves exact source metadata, generates independent native IDs/times and stable hashes", async () => {
    const saved = await saveCmsDraft(request());
    const revision = state.cmsRevision[0];
    expect(saved.nativeRev).not.toBe(content()._rev);
    expect(saved.documentId).not.toBe(content()._id);
    expect(revision).toMatchObject({ sourceRev: null, sourceCreatedAt: null,
      sourceUpdatedAt: null, sourceRecordRaw: null, sourceSha256: null, createdAt: now, ingestedAt: now,
      provenance: { canonicalization: "jongo-json-sorted-v1", origin: "native", submittedEnvelopeTrusted: false,
        submittedEnvelope: { _rev: content()._rev, _createdAt: content()._createdAt, _updatedAt: content()._updatedAt } } });
    expect(revision.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    const sorted = (v: any): string => v && typeof v === "object" ? Array.isArray(v)
      ? `[${v.map(sorted).join(",")}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${sorted(v[k])}`).join(",")}}` : JSON.stringify(v);
    expect(revision.payloadSha256).toBe(createHash("sha256").update(sorted(content())).digest("hex"));
    const reversed = Object.fromEntries(Object.entries(content()).reverse());
    expect(await saveCmsDraft(request({ input: reversed }))).toEqual(saved);
  });
});

describe("immutable revisions, CAS, atomic audit and receipts", () => {
  it("replays exact raw requests after a schema version/rule upgrade or removal, but validates new mutations", async () => {
    const original = cmsSchemaRegistry.get("partnerStories")!;
    const first = await saveCmsDraft(request());
    const before = structuredClone(state);
    const lookup = createSchemaRegistry(cmsSchemas).get;
    vi.mocked(cmsSchemaRegistry.get).mockImplementation((name) => name === "partnerStories"
      ? { ...original, schemaVersion: 2, fields: [...original.fields, { name: "newRequired", type: "string", required: true }] } as any
      : lookup(name));
    expect(await saveCmsDraft(request())).toEqual(first);
    expect(state).toEqual(before);
    await rejected(saveCmsDraft(request({ mutationId: "new-schema", expectedNativeRev: first.nativeRev })), "invalid");
    vi.mocked(cmsSchemaRegistry.get).mockReturnValue(undefined);
    expect(await saveCmsDraft(request())).toEqual(first);
    await rejected(saveCmsDraft(request({ mutationId: "removed-schema", expectedNativeRev: first.nativeRev })), "invalid");
    // Submitted metadata is still fingerprinted exactly, not stripped to replay.
    await rejected(saveCmsDraft(request({ input: { ...content(), _rev: "changed-source-claim" } })), "conflict");
    await rejected(saveCmsDraft(request({ input: { ...content(), _updatedAt: "2022-01-01T00:00:00Z" } })), "conflict");
    dataset().grants[0].revokedAt = now as any;
    await rejected(saveCmsDraft(request()), "denied");
  });
  it("preserves imported source metadata, raw bytes/hash and provenance when an editor changes envelope claims", async () => {
    const first = await saveCmsDraft(request());
    const source = { sourceRev: "original-import-rev", sourceCreatedAt: "opaque original date",
      sourceUpdatedAt: "original update", sourceRecordRaw: '{ "original": "exact bytes" }',
      sourceSha256: "a".repeat(64), provenance: { adapter: "approved-import-v1", source: { project: "fixture" } } };
    Object.assign(state.cmsRevision[0], structuredClone(source));
    const before = structuredClone(state.cmsRevision[0]);
    const input = { ...content(), _rev: "EDITOR_CLAIM", _createdAt: "2023-01-01T00:00:00Z",
      _updatedAt: "2024-01-01T00:00:00Z", quote: "Edited" };
    await saveCmsDraft(request({ input, mutationId: "edit-source", expectedNativeRev: first.nativeRev }));
    expect(state.cmsRevision[0]).toEqual(before);
    expect(state.cmsRevision[1]).toMatchObject(source);
    expect(state.cmsRevision[1].payload).toEqual(input);
    const locks = trace.filter((entry) => entry.name === "queryRaw" && entry.query.sql.includes('FROM "CmsDocument"'));
    expect(locks).toHaveLength(1);
    expect(locks[0].query).toEqual({
      sql: 'SELECT id FROM "CmsDocument" WHERE "datasetId" = ?::uuid AND id = ?::uuid FOR UPDATE',
      values: [datasetId, first.documentId]
    });
  });
  it("preserves the original untrusted creation envelope over later native edits", async () => {
    const first = await saveCmsDraft(request());
    const original = structuredClone(state.cmsRevision[0].provenance);
    await saveCmsDraft(request({ mutationId: "edit-envelope", expectedNativeRev: first.nativeRev,
      input: { ...content(), _rev: "new-claim", _updatedAt: "2025-01-01T00:00:00Z" } }));
    expect(state.cmsRevision[1].provenance).toEqual(original);
    expect(state.cmsRevision[1].sourceRev).toBeNull();
  });
  it("inserts final receipt before linked revision, CAS then scoped redacted audit", async () => {
    const saved = await saveCmsDraft(request());
    expect(writes().map((entry) => entry.name)).toEqual([
      "cmsDocument.create", "cmsMutation.create", "cmsRevision.create", "cmsDocument.updateMany", "auditLog.create"
    ]);
    const revision = state.cmsRevision[0], mutation = state.cmsMutation[0];
    expect(revision.mutationId).toBe(mutation.id);
    expect(revision.actorId).toBe(mutation.actorId);
    expect(mutation.result).toEqual(saved);
    const cas = trace.find((entry) => entry.name === "cmsDocument.updateMany")!.query;
    expect(cas.where).toMatchObject({ datasetId, id: saved.documentId, lockVersion: 0, currentRevisionId: null, archivedAt: null });
    expect(cas.data.lockVersion).toEqual({ increment: 1 });
    expect(state.auditLog[0]).toMatchObject({ organizationId: orgId, actorId });
    const audit = JSON.stringify(state.auditLog[0]);
    for (const privateValue of ["PRIVATE", "Private draft quote", "payload\"", "SOURCE_NOT_NATIVE_CAS"]) expect(audit).not.toContain(privateValue);
  });
  it.each(["cmsDocument.create", "cmsMutation.create", "cmsRevision.create", "cmsDocument.updateMany", "auditLog.create", "queryRaw", "executeRaw"])(
    "rolls back all rows after %s failure without SQL detail", async (point) => {
      failure = point;
      const before = structuredClone(state);
      await rejected(saveCmsDraft(request()), "unavailable");
      expect(state).toEqual(before);
    }
  );
  it("CAS count zero rolls back creation, receipt and revision", async () => {
    casMiss = true;
    await rejected(saveCmsDraft(request()), "conflict");
    expect(state.cmsDocument).toEqual([]); expect(state.cmsMutation).toEqual([]);
    expect(state.cmsRevision).toEqual([]); expect(state.auditLog).toEqual([]);
  });
  it("requires native CAS, never source _rev, and never mutates retained revision", async () => {
    const first = await saveCmsDraft(request());
    const before = structuredClone(state);
    await rejected(saveCmsDraft(request({ mutationId: "edit", expectedNativeRev: content()._rev })), "conflict");
    expect(state).toEqual(before);
    const second = await saveCmsDraft(request({ mutationId: "edit", expectedNativeRev: first.nativeRev,
      expectedLockVersion: first.lockVersion, input: { ...content(), quote: "Second" } }));
    expect(second.sequence).toBe(2); expect(second.lockVersion).toBe(2);
    expect(state.cmsRevision[0]).toEqual(before.cmsRevision[0]);
    await rejected(saveCmsDraft(request({ mutationId: "stale", expectedNativeRev: first.nativeRev })), "conflict");
    await rejected(saveCmsDraft(request({ mutationId: "stale-version", expectedNativeRev: second.nativeRev, expectedLockVersion: 1 })), "conflict");
  });
  it("old retry returns its original receipt but cannot overwrite the latest edit", async () => {
    const first = await saveCmsDraft(request());
    const second = await saveCmsDraft(request({ mutationId: "edit", expectedNativeRev: first.nativeRev, input: { ...content(), quote: "Second" } }));
    const before = structuredClone(state);
    expect(await saveCmsDraft(request())).toEqual(first);
    expect(state).toEqual(before);
    expect(state.cmsDocument[0].currentRevisionId).toBe(second.revisionId);
  });
  it("same key with different payload, actor or expectation conflicts", async () => {
    const first = await saveCmsDraft(request());
    await rejected(saveCmsDraft(request({ input: { ...content(), quote: "changed" } })), "conflict");
    await rejected(saveCmsDraft(request({ expectedNativeRev: first.nativeRev })), "conflict");
    state.user.push({ id: ownerId, deletedAt: null, role: "collaborator" });
    await rejected(saveCmsDraft(request({ userId: ownerId })), "conflict");
    expect(state.cmsRevision).toHaveLength(1); expect(state.auditLog).toHaveLength(1);
  });
  it("concurrent same-body retries commit exactly one success; changed-body retry conflicts", async () => {
    const [a, b] = await Promise.all([saveCmsDraft(request()), saveCmsDraft(request())]);
    expect(a).toEqual(b);
    expect(state.cmsRevision).toHaveLength(1); expect(state.cmsMutation).toHaveLength(1); expect(state.auditLog).toHaveLength(1);
    const outcomes = await Promise.allSettled([
      saveCmsDraft(request({ mutationId: "edit", expectedNativeRev: a.nativeRev, input: { ...content(), quote: "A" } })),
      saveCmsDraft(request({ mutationId: "edit", expectedNativeRev: a.nativeRev, input: { ...content(), quote: "B" } }))
    ]);
    expect(outcomes[0].status).toBe("fulfilled"); expect(outcomes[1].status).toBe("rejected");
    expect(state.cmsRevision).toHaveLength(2);
  });
  it.each(["P2002", "P2034"])("retries %s only in a fresh authorized transaction", async (code) => {
    injectedCode = code;
    await saveCmsDraft(request());
    expect(attempts).toBe(2);
    expect(trace.filter((entry) => entry.name === "user.findUnique")).toHaveLength(4);
    expect(trace.filter((entry) => entry.name === "preliminary.user.findUnique")).toHaveLength(2);
    expect(state.cmsRevision).toHaveLength(1); expect(state.auditLog).toHaveLength(1);
  });
  it.each(["40001", "40P01"])("retries raw-lock SQLSTATE %s with new authorization and a new transaction", async (code) => {
    let once = true;
    duringLock = () => {
      if (once) { once = false; throw { code: "P2010", meta: { code } }; }
    };
    await saveCmsDraft(request());
    expect(attempts).toBe(2);
    expect(trace.filter((entry) => entry.name === "preliminary.user.findUnique")).toHaveLength(2);
    expect(state.cmsRevision).toHaveLength(1);
  });
  it("bounds repeated row-lock serialization failures and retains no writes", async () => {
    duringLock = () => { throw { code: "P2010", meta: { code: "40001" } }; };
    await rejected(saveCmsDraft(request()), "conflict");
    expect(attempts).toBe(3);
    expect(writes()).toEqual([]);
  });
  it("does not replay after membership revocation", async () => {
    await saveCmsDraft(request());
    dataset().organization.collaborators = [];
    await rejected(saveCmsDraft(request()), "denied");
  });
  it("never follows explicit document ID across datasets or rewrites published identities", async () => {
    const first = await saveCmsDraft(request());
    state.cmsDocument[0].datasetId = id(90);
    await rejected(saveCmsDraft(request({ documentId: first.documentId, mutationId: "edit", expectedNativeRev: first.nativeRev })), "conflict");
    state.cmsDocument[0].datasetId = datasetId; state.cmsDocument[0].variant = "published";
    await rejected(saveCmsDraft(request({ mutationId: "edit", expectedNativeRev: first.nativeRev })), "conflict");
  });
});

describe("scoped reference indexing and failure boundaries", () => {
  it("retains weak and strong unresolved references privately, with exact RFC6901 paths", async () => {
    const input = { ...content(), relatedWork: { _type: "reference", _ref: "drafts.exact", _weak: true } };
    await saveCmsDraft(request({ input }));
    expect(state.cmsReference[0]).toMatchObject({ datasetId, path: "/relatedWork", sourceRef: "drafts.exact", weak: true,
      state: "unresolved", targetDocumentId: null, diagnosticCode: "target_unverified" });
    expect(state.cmsRevision[0].payload.relatedWork).toEqual(input.relatedWork);
  });
  it("resolves only exact same-dataset targets and checks the registered target type", async () => {
    const input = { ...content(), relatedWork: { _type: "reference", _ref: "work" } };
    state.cmsDocument.push({ id: id(50), datasetId: id(90), nativeId: "work", type: "agencyWork", archivedAt: null });
    await saveCmsDraft(request({ input }));
    expect(state.cmsReference[0].state).toBe("unresolved");
    state.cmsDocument[0].datasetId = datasetId; state.cmsDocument[0].type = "partnerStories";
    const before = structuredClone(state);
    await rejected(saveCmsDraft(request({ mutationId: "edit", input, expectedNativeRev: state.cmsRevision[0].nativeRev })), "invalid");
    expect(state).toEqual(before);
  });
  it("edge failure rolls back receipt, revision, document and audit", async () => {
    failure = "cmsReference.create";
    const before = structuredClone(state);
    await rejected(saveCmsDraft(request({ input: { ...content(), relatedWork: { _type: "reference", _ref: "work" } } })), "unavailable");
    expect(state).toEqual(before);
  });
  it("fails closed without a DB, delegates, raw lock support or for malformed IDs", async () => {
    m.getDb.mockResolvedValueOnce(null);
    await rejected(saveCmsDraft(request()), "unavailable");
    m.getDb.mockResolvedValueOnce({ $transaction: (cb: any) => cb({}) });
    await rejected(saveCmsDraft(request()), "unavailable");
    await rejected(saveCmsDraft(request({ userId: "not-a-session-id" })), "denied");
    expect(new CmsDocumentError("invalid").message).not.toContain("SQL");
  });
});

describe("schema-independent raw form receipts", () => {
  const formRequest = () => {
    const { _id, _type, _rev, _createdAt, _updatedAt } = content();
    return { ...scope, sourceId: _id, envelope: { _id, _type, _rev, _createdAt, _updatedAt },
      mutationId: "form-retry", expectedNativeRev: null,
      serializedForm: JSON.stringify(cmsFormValues(cmsSchemaRegistry.get(_type)!, content())) };
  };
  it.each(["removed", "changed"])("replays exact raw transport before %s schema validation and rejects changed requests", async (kind) => {
    const input = formRequest();
    const saved = await saveCmsDraftForm(input);
    const retained = structuredClone(state);
    const original = createSchemaRegistry(cmsSchemas).get;
    vi.mocked(cmsSchemaRegistry.get).mockImplementation(name => kind === "removed" ? undefined
      : ({ ...original(name)!, fields: [] } as unknown as ReturnType<typeof original>));
    expect(await saveCmsDraftForm(input)).toEqual(saved);
    expect(state).toEqual(retained);
    await rejected(saveCmsDraftForm({ ...input, serializedForm: input.serializedForm + " " }), "conflict");
    await rejected(saveCmsDraftForm({ ...input, envelope: { ...input.envelope, _rev: "changed" } }), "conflict");
    await rejected(saveCmsDraftForm({ ...input, expectedNativeRev: "changed" }), "conflict");
    await rejected(saveCmsDraftForm({ ...input, mutationId: "new-key" }), "invalid");
    dataset().organization.owner.subscriptionPlanId = "pro";
    await rejected(saveCmsDraftForm(input), "denied");
    expect(state.cmsRevision).toHaveLength(1);
  });
  it.each(["{", "[]", '{"_id":"drafts.evil"}', '{"company":true}', '{"logoVerified":"true"}', '{"logo":"plain-id"}'])("validates new form submissions in the guarded transaction: %s", async (serializedForm) => {
    await rejected(saveCmsDraftForm({ ...formRequest(), serializedForm }), "invalid");
    expect(writes()).toEqual([]);
  });
  it("never rewinds a later revision and denies raw-form replay after either flag or grant revocation", async () => {
    const input = formRequest();
    const first = await saveCmsDraftForm(input);
    const next = await saveCmsDraftForm({ ...input, documentId: first.documentId, expectedNativeRev: first.nativeRev,
      mutationId: "later-form", serializedForm: JSON.stringify({ ...JSON.parse(input.serializedForm), company: "Later" }) });
    expect(await saveCmsDraftForm(input)).toEqual(first);
    expect(state.cmsDocument[0].currentRevisionId).toBe(next.revisionId);
    expect(state.cmsRevision).toHaveLength(2);
    for (const flag of ["JONGO_CMS_ENABLED", "JONGO_CMS_WRITES_ENABLED"]) {
      vi.stubEnv(flag, "false");
      await rejected(saveCmsDraftForm(input), "denied");
      vi.stubEnv(flag, "true");
    }
    dataset().grants[0].revokedAt = now as any;
    await rejected(saveCmsDraftForm(input), "denied");
    expect(state.cmsRevision).toHaveLength(2);
  });
  it("persists full reference objects and empty nested dictionary values through save/read/reload", async () => {
    const input = formRequest();
    const values = JSON.parse(input.serializedForm);
    values.relatedWork = JSON.stringify({ _type: "reference", _ref: "missing-work", _weak: true, _key: "ref-key" });
    const saved = await saveCmsDraftForm({ ...input, serializedForm: JSON.stringify(values) });
    const loaded = await getCmsDocument({ ...scope, documentId: saved.documentId });
    expect((loaded!.draft!.payload as any).relatedWork).toEqual(JSON.parse(values.relatedWork));
    expect(state.cmsReference[0]).toMatchObject({ sourceRef: "missing-work", weak: true });
    const dictionary = { ...input, sourceId: "drafts.dictionary", mutationId: "dictionary",
      envelope: { ...input.envelope, _id: "drafts.dictionary", _type: "languageDictionary" },
      serializedForm: JSON.stringify({ audience: "common", locale: "en", version: "1", entries: JSON.stringify([
        { _type: "dictionaryEntry", _key: "entry", key: "empty", value: "", placeholders: [], format: "plain", status: "draft", revision: "1" }
      ]) }) };
    const result = await saveCmsDraftForm(dictionary);
    const reloaded = await getCmsDocument({ ...scope, documentId: result.documentId });
    expect((reloaded!.draft!.payload as any).entries[0].value).toBe("");
  });
});