import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertReviewedSnapshot, parseRecord, readNdjson, READER_LIMITS, sha256 } from "./reader";
import { canonical, MAPPING, planImport } from "./planner";
import { cmsSchemaRegistry } from "../schemas";
import { assertLocalDatabase } from "./local-database";
import { parseArguments } from "../../../../../../scripts/import-sanity-ndjson";

const m = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: m.getDb }));
import { importSanity } from "./service";

const actorId = "11111111-1111-4111-8111-111111111111";
const datasetId = "22222222-2222-4222-8222-222222222222";
const organizationId = "33333333-3333-4333-8333-333333333333";
const databaseName = "cms_import_test_synthetic";
let directory: string, file: string, expectedSha256: string;
function document(id = "drafts.example:one") {
  return { _id: id, _type: "productLanding", _rev: "opaque.source.rev",
    _createdAt: "2020-01-01T00:00:00Z", _updatedAt: "2021-01-01T00:00:00.123Z",
    product: "jongo", sections: [{ _type: "features", _key: "feature", version: 1, body: [{
      _type: "block", _key: "block", style: "blockquote2", listItem: "number", level: 2,
      markDefs: [{ _type: "link", _key: "annotation", href: "/safe" }], children: [
        { _type: "span", _key: "span", text: "Exact 😀 punctuation & <text>.", marks: ["annotation", "superscript"] }
      ] }] }] };
}
async function source(records: unknown[]) {
  const bytes = records.map(r => JSON.stringify(r)).join("\n");
  await writeFile(file, bytes);
  expectedSha256 = sha256(bytes);
}
const options = () => ({ file, datasetId, actorId, apply: true, confirmDataset: datasetId, expectedSha256 });
beforeEach(async () => {
  vi.resetAllMocks();
  directory = await mkdtemp(join(tmpdir(), "cms-import-generated-")); file = join(directory, "synthetic.ndjson");
  vi.stubEnv("DATABASE_URL", `postgresql://synthetic:synthetic@127.0.0.1:1/${databaseName}`);
  vi.stubEnv("DATABASE_NAME", databaseName); vi.stubEnv("JONGO_CMS_ENABLED", "true");
  vi.stubEnv("JONGO_CMS_WRITES_ENABLED", "true");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

describe("strict bounded read-only NDJSON", () => {
  it.each([
    ['{"x":1,"x":2}', "duplicate_key"], ['{"x":1,"\\u0078":2}', "duplicate_key"],
    ['{"nested":{"constructor":1}}', "unsafe_key"], ['{"__proto__":{}}', "unsafe_key"],
    ['{"x":1,}', "json"], ['[1,]', "json"], ['{"x":NaN}', "json"], ['{"x":01}', "json"],
    ['{"x":"\\ud800"}', "unicode"], ['{"x":"\\u0000"}', "unicode"],
    ['{"x":9007199254740993}', "number"], ['{"x":1e999}', "number"],
    ["[".repeat(34) + "0" + "]".repeat(34), "depth_limit"],
    [JSON.stringify(Array.from({ length: 2001 }, () => 0)), "collection_limit"]
  ])("rejects malformed/budgeted source without returning its body (case %#)", (raw, code) => {
    expect(() => parseRecord(raw)).toThrow(`CMS import ${code}.`);
  });
  it("accepts safe maps, nested key reuse and literal escapes without prototype merges", () => {
    const value = parseRecord('{"a":{"x":1},"b":{"x":2},"text":"\\\\u0000😀"}');
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(value).toEqual({ a: { x: 1 }, b: { x: 2 }, text: "\\u0000😀" });
  });
  it("hashes exact bytes, strips only BOM/delimiters and counts physical blank lines", async () => {
    const raw = `  ${JSON.stringify(document())}  `;
    const bytes = Buffer.from(`\ufeff\r\n\t\n${raw}\r\n`);
    await writeFile(file, bytes);
    const records: any[] = [];
    const result = await readNdjson(file, r => { records.push(r); });
    expect(result).toEqual({ bytes: bytes.length, sha256: sha256(bytes), records: 1, blanks: 2 });
    expect(records[0]).toMatchObject({ raw, sha256: sha256(raw), line: 3, offset: 7 });
    expect(await readFile(file)).toEqual(bytes);
  });
  it("decodes multibyte Unicode across fixed-buffer boundaries", async () => {
    const raw = JSON.stringify({ text: "a".repeat(65525) + "😀" });
    await writeFile(file, raw);
    await readNdjson(file, r => { expect(r.raw).toBe(raw); });
  });
  it.each([Buffer.from([0xff]), Buffer.from('{"x":"\ufeff"}')])("rejects invalid UTF-8/misplaced BOM", async bytes => {
    await writeFile(file, bytes); await expect(readNdjson(file, () => {})).rejects.toMatchObject({ code: bytes[0] === 255 ? "utf8" : "bom" });
  });
  it("stops oversized lines before parsing and redacts parse failures", async () => {
    await writeFile(file, "x".repeat(READER_LIMITS.line + 1));
    await expect(readNdjson(file, () => {})).rejects.toMatchObject({ code: "line_limit" });
    await writeFile(file, '{"SECRET_MARKER":');
    await expect(readNdjson(file, () => {})).rejects.toThrow("CMS import json at physical line 1.");
  });
  it("detects source mutation during processing", async () => {
    await source([document()]);
    await expect(readNdjson(file, async () => { await writeFile(file, " "); })).rejects.toMatchObject({ code: "source_changed" });
  });
  it.each([undefined, "", "PRIVATE_HASH_CANARY", "a".repeat(63), "a".repeat(65), "g".repeat(64), "a".repeat(63) + "\n"])("rejects missing/malformed review hashes with one bounded diagnostic (case %#)", value => {
    expect(() => assertReviewedSnapshot(value)).toThrow("CMS import snapshot_confirmation.");
  });
  it("normalizes only valid hexadecimal review hashes and never echoes mismatches", () => {
    expect(assertReviewedSnapshot("A".repeat(64), "a".repeat(64))).toBe("a".repeat(64));
    expect(() => assertReviewedSnapshot("a".repeat(64), "b".repeat(64))).toThrow("CMS import snapshot_confirmation.");
  });
});

describe("deterministic conservative planning", () => {
  it("preserves raw native envelope and Portable Text exactly without calling DB", async () => {
    const body = document(); await source([body]);
    const first = await planImport(file), second = await planImport(file);
    expect(first).toEqual(second); expect(first.candidates[0].value).toEqual(body);
    expect(first.candidates[0].raw).toBe(JSON.stringify(body));
    expect(first.report.snapshot).toEqual(first.snapshot);
    expect(first.report.snapshot.sha256).toBe(sha256(await readFile(file)));
    expect(first.report.counts).toEqual({ eligible: 1, quarantined: 0, excluded_secret: 0, excluded_operational: 0 });
    expect(m.getDb).not.toHaveBeenCalled();
  });
  it("pins original bytes even when whitespace changes leave the eligible payload unchanged", async () => {
    await source([document()]);
    const reviewed = await planImport(file);
    await writeFile(file, `\ufeff\r\n ${JSON.stringify(document())} \r\n`);
    const changed = await planImport(file);
    expect(changed.candidates[0].payloadSha256).toBe(reviewed.candidates[0].payloadSha256);
    expect(changed.report.snapshot.sha256).not.toBe(reviewed.report.snapshot.sha256);
    expect(changed.report.snapshot.sha256).toBe(sha256(await readFile(file)));
    expect(m.getDb).not.toHaveBeenCalled();
  });
  it("quarantines unknown/custom/asset/published records before canonical writes and excludes operational secrets", async () => {
    const custom = document("drafts.custom"); (custom.sections[0].body[0] as any)._type = "then_now_gallery";
    await source([document("source-published"), { ...document("drafts.unknown"), _type: "waterfall" }, custom,
      { _id: "asset", _type: "sanity.imageAsset", url: "https://never-fetch.test/SECRET" },
      { _id: "secret", _type: "mux.apiKey", key: "NEVER_PERSIST" },
      { _id: "operational", _type: "notificationRequest", email: "PRIVATE" }]);
    const plan = await planImport(file);
    expect(plan.candidates).toEqual([]);
    expect(plan.report.counts).toEqual({ eligible: 0, quarantined: 4, excluded_secret: 1, excluded_operational: 1 });
    expect(JSON.stringify(plan.report)).not.toMatch(/NEVER_PERSIST|PRIVATE|never-fetch/);
    expect(JSON.stringify(plan)).not.toContain("NEVER_PERSIST");
  });
  it("rejects duplicate IDs even across excluded records", async () => {
    await source([document(), document()]); await expect(planImport(file)).rejects.toMatchObject({ code: "duplicate_id" });
    await source([{ _id: "s", _type: "mux.apiKey" }, { _id: "s", _type: "mux.apiKey" }]);
    await expect(planImport(file)).rejects.toMatchObject({ code: "duplicate_id" });
  });
  it("accepts cycles/forward exact references, closes excluded strong targets and preserves weak findings", async () => {
    const a = document("drafts.a"), b = document("drafts.b");
    const ref = (id: string, weak = false) => ({ _type: "reference", _key: "inline", _ref: id, _weak: weak });
    (a.sections[0].body[0].children as any).push(ref("drafts.b"));
    (b.sections[0].body[0].children as any).push(ref("drafts.a"));
    await source([a, b]); expect((await planImport(file)).candidates).toHaveLength(2);
    (b.sections[0].body[0].children as any)[1] = ref("missing");
    await source([a, b]); expect((await planImport(file)).candidates).toHaveLength(0);
    (b.sections[0].body[0].children as any)[1] = ref("missing", true);
    await source([a, b]); expect((await planImport(file)).candidates).toHaveLength(2);
    (b.sections[0].body[0].children as any)[1] = ref("b");
    await source([a, b]); expect((await planImport(file)).candidates).toHaveLength(0);
  });
});

describe("operator preflight", () => {
  it("executes the real CLI launcher: default dry-run works with no DB and unsafe apply fails redacted", async () => {
    await source([document(), { _id: "secret", _type: "mux.apiKey", key: "PRIVATE_CLI_CANARY" }]);
    const run = promisify(execFile), root = resolve(process.cwd(), "../..");
    const argv = [join(root, "scripts/run-typescript.cjs"), "scripts/import-sanity-ndjson.ts", "--file", file, "--dataset-id", datasetId, "--actor-id", actorId];
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, DATABASE_URL: "", DATABASE_NAME: "" };
    const result = await run(process.execPath, argv, { cwd: directory, env });
    expect(result.stderr).toBe(""); expect(result.stdout).not.toContain("PRIVATE_CLI_CANARY");
    const reviewed = JSON.parse(result.stdout);
    expect(reviewed).toMatchObject({ mode: "dry-run", applied: 0, eligible: 1, counts: { excluded_secret: 1 }, snapshot: { sha256: sha256(await readFile(file)) } });
    const explicitDryRun = await run(process.execPath, [...argv, "--dry-run"], { cwd: directory, env });
    expect(explicitDryRun).toEqual(result);
    // A valid reviewed hash must still reach (and fail) the existing DB gate.
    await expect(run(process.execPath, [...argv, "--apply", "--confirm-dataset", datasetId, "--expected-sha256", reviewed.snapshot.sha256], { cwd: directory, env }))
      .rejects.toMatchObject({ code: 1, stdout: "", stderr: "CMS import isolated_database_required.\n" });
  });
  it("real CLI rejects missing, invalid and changed reviewed snapshots without loading the DB bridge", async () => {
    await source([document(), { _id: "secret", _type: "mux.apiKey", key: "PRIVATE_CLI_CANARY" }]);
    const run = promisify(execFile), root = resolve(process.cwd(), "../..");
    const argv = [join(root, "scripts/run-typescript.cjs"), "scripts/import-sanity-ndjson.ts", "--file", file,
      "--dataset-id", datasetId, "--actor-id", actorId, "--apply", "--confirm-dataset", datasetId];
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP,
      DATABASE_NAME: databaseName, DATABASE_URL: `postgresql://synthetic:synthetic@127.0.0.1:1/${databaseName}` };
    const reviewed = expectedSha256;
    await writeFile(file, (await readFile(file, "utf8")) + "\n");
    for (const suffix of [[], ["--expected-sha256", "PRIVATE_HASH_CANARY"], ["--expected-sha256", reviewed]]) {
      await expect(run(process.execPath, [...argv, ...suffix], { cwd: directory, env }))
        .rejects.toMatchObject({ code: 1, stdout: "", stderr: "CMS import snapshot_confirmation.\n" });
    }
  });
  it("defaults to dry-run and requires explicit target/actor/file", () => {
    const argv = ["--file", "external.ndjson", "--dataset-id", datasetId, "--actor-id", actorId];
    expect(parseArguments(argv).apply).toBe(false);
    expect(parseArguments([...argv, "--apply", "--confirm-dataset", datasetId, "--expected-sha256", "A".repeat(64)]))
      .toMatchObject({ apply: true, confirmDataset: datasetId, expectedSha256: "a".repeat(64) });
    for (const suffix of [["--apply", "--dry-run"], ["--wat"], ["--file", "other"], ["--confirm-dataset", datasetId],
      ["--expected-sha256", "a".repeat(64)], ["--apply"], ["--apply", "--expected-sha256"],
      ["--apply", "--expected-sha256", "x".repeat(64)], ["--apply", "--expected-sha256", "a".repeat(64), "--expected-sha256", "b".repeat(64)]]) expect(() => parseArguments([...argv, ...suffix])).toThrow();
    expect(() => parseArguments([])).toThrow();
  });
  it.each([
    "postgresql://x:x@remote.example/cms_import_test_synthetic",
    "postgresql://x:x@127.0.0.1/postgres",
    "postgresql://x:x@127.0.0.1/cms_import_test_synthetic?host=remote.example",
    "postgresql://x:x@127.0.0.1/cms_import_test_synthetic?schema=private"
  ])("rejects unsafe DB configuration before connecting", url => {
    expect(() => assertLocalDatabase({ NODE_ENV: "test", DATABASE_URL: url, DATABASE_NAME: databaseName })).toThrow();
  });
  it("requires confirmation and rejects production even with loopback", async () => {
    await expect(importSanity({ ...options(), confirmDataset: undefined })).rejects.toMatchObject({ code: "confirmation_required" });
    expect(m.getDb).not.toHaveBeenCalled();
    vi.stubEnv("NODE_ENV", "production"); expect(() => assertLocalDatabase()).toThrow();
  });
});

/** Detached rollback-aware DB double exercises the REAL document policy bridge,
 * not a mocked authorization bit. This is not PostgreSQL concurrency evidence. */
function database() {
  let state: Record<string, any[]> = { cmsDocument: [], cmsRevision: [], cmsMutation: [], cmsReference: [], auditLog: [] };
  let plan = "core-sla", member = true, failure = "", cas = false, revokeDuringLock = false;
  const locks: string[] = [];
  const scope = () => ({ id: datasetId, organizationId, siteId: null, archivedAt: null,
    organization: { id: organizationId, ownerId: actorId, deletedAt: null,
      owner: { id: actorId, deletedAt: null, subscriptionPlanId: plan, subscriptionStatus: "active", subscriptionCurrentPeriodEnd: new Date("2099-01-01T00:00:00Z") }, collaborators: [] },
    grants: [], site: null });
  const matches = (row: any, q: any): boolean => Object.entries(q ?? {}).every(([key, value]) => key === "datasetId_key" ? matches(row, value) : row[key] === value);
  const policy = {
    user: { findUnique: async () => member ? { id: actorId, deletedAt: null } : null },
    cmsDataset: { findUnique: async () => scope() }
  };
  const db = { ...policy, $transaction: async (callback: any) => {
    const work = structuredClone(state);
    const tx: any = { ...policy, $executeRaw: async () => 0,
      $queryRaw: async (strings: TemplateStringsArray) => {
        const sql = strings.join("?"); locks.push(sql);
        if (revokeDuringLock && sql.includes('"User"')) member = false;
        return sql.includes("current_database") ? [{ name: databaseName, address: "127.0.0.1/32" }] : [];
      } };
    for (const [name, rows] of Object.entries(work)) {
      tx[name] = {
        findUnique: async (q: any) => rows.find(r => matches(r, q.where)) ?? null,
        findFirst: async (q: any) => rows.find(r => matches(r, q.where)) ?? null,
        create: async (q: any) => {
          if (failure === name) throw new Error("PRIVATE_SQL_SECRET");
          const row = { archivedAt: null, ...q.data }; rows.push(row); return row;
        },
        updateMany: async (q: any) => {
          if (cas) return { count: 0 };
          const found = rows.filter(r => matches(r, q.where));
          for (const row of found) Object.assign(row, q.data, { lockVersion: row.lockVersion + 1 });
          return { count: found.length };
        }
      };
    }
    const result = await callback(tx); state = work; return result;
  } };
  m.getDb.mockResolvedValue(db);
  return { rows: () => state, locks, setPlan: (v: string) => { plan = v; }, revoke: () => { member = false; },
    revokeAtLock: () => { revokeDuringLock = true; }, fail: (v: string) => { failure = v; }, casMiss: () => { cas = true; } };
}

describe("atomic guarded apply", () => {
  it.each([undefined, "", "PRIVATE_HASH_CANARY", "g".repeat(64), "a".repeat(63)])("rejects missing/invalid reviewed hashes before source or DB access (case %#)", async expectedSha256 => {
    const db = database();
    await expect(importSanity({ ...options(), expectedSha256 })).rejects.toThrow("CMS import snapshot_confirmation.");
    expect(m.getDb).not.toHaveBeenCalled();
    expect(db.locks).toEqual([]);
    for (const rows of Object.values(db.rows())) expect(rows).toEqual([]);
  });
  it("rejects changed snapshots before DB access or writes, including receipt replay", async () => {
    const db = database(); await source([document()]);
    const reviewed = options();
    await importSanity(reviewed);
    const retained = structuredClone(db.rows()); db.locks.length = 0; m.getDb.mockClear();
    // Same parsed body and source identity, different original bytes.
    await writeFile(file, ` ${JSON.stringify(document())}\n`);
    await expect(importSanity(reviewed)).rejects.toThrow("CMS import snapshot_confirmation.");
    expect(m.getDb).not.toHaveBeenCalled(); expect(db.locks).toEqual([]);
    expect(db.rows()).toEqual(retained);
  });
  it("rejects a mismatched review on the first apply without locks, writes or source changes", async () => {
    const db = database(); await source([document()]);
    const bytes = await readFile(file);
    await expect(importSanity({ ...options(), expectedSha256: "0".repeat(64) })).rejects.toThrow("CMS import snapshot_confirmation.");
    expect(m.getDb).not.toHaveBeenCalled(); expect(db.locks).toEqual([]);
    for (const rows of Object.values(db.rows())) expect(rows).toEqual([]);
    expect(await readFile(file)).toEqual(bytes);
  });
  it.each([undefined, "false", "TRUE", "1", " true "])("denies apply without locks, writes or receipts for write rollout %s", async value => {
    const db = database(); await source([document()]);
    vi.stubEnv("JONGO_CMS_WRITES_ENABLED", value);
    await expect(importSanity(options())).rejects.toMatchObject({ code: "denied" });
    expect(m.getDb).not.toHaveBeenCalled();
    expect(db.locks).toEqual([]);
    for (const rows of Object.values(db.rows())) expect(rows).toEqual([]);
  });
  it.each([undefined, "false", "TRUE"])("denies import receipt replay when write rollout is %s", async value => {
    const db = database(); await source([document()]); await importSanity(options());
    const retained = structuredClone(db.rows()); db.locks.length = 0; m.getDb.mockClear();
    vi.stubEnv("JONGO_CMS_WRITES_ENABLED", value);
    await expect(importSanity(options())).rejects.toMatchObject({ code: "denied" });
    expect(m.getDb).not.toHaveBeenCalled();
    expect(db.locks).toEqual([]);
    expect(db.rows()).toEqual(retained);
  });

  it("inserts exact source/raw/hash/AST with separate native revision and one immutable receipt; retries do not overwrite later edits", async () => {
    const db = database(), body = document(); await source([body]);
    const raw = await readFile(file, "utf8");
    const result = await importSanity(options());
    expect(result.applied).toBe(1); expect(result.jobId).toMatch(/^sanity-v1:/);
    expect(db.rows().cmsDocument[0]).toMatchObject({ nativeId: body._id, logicalId: "example:one", variant: "draft", lockVersion: 1 });
    expect(db.rows().cmsRevision[0]).toMatchObject({ payload: body, sourceRev: body._rev, sourceRecordRaw: raw, sourceSha256: sha256(raw), sourceCreatedAt: body._createdAt });
    expect(db.rows().cmsRevision[0].nativeRev).not.toBe(body._rev);
    const planned = await planImport(file);
    expect(db.rows().cmsRevision[0].provenance.snapshotSha256).toBe(expectedSha256);
    expect(db.rows().cmsMutation[0].requestSha256).toBe(sha256(canonical({ mapping: MAPPING, actorId, datasetId,
      snapshot: expectedSha256, schemaHash: sha256(canonical(cmsSchemaRegistry.descriptors as unknown as import("../validation").JsonValue)),
      entries: planned.candidates.map(c => [c.value._id, c.sha256, c.payloadSha256]) })));
    const pointer = db.rows().cmsDocument[0].currentRevisionId = "later-editor-revision";
    const replay = await importSanity({ ...options(), expectedSha256: expectedSha256.toUpperCase() }); expect(replay).toMatchObject({ applied: 0, replayed: true, jobId: result.jobId });
    expect(db.rows().cmsDocument[0].currentRevisionId).toBe(pointer);
    expect(db.rows().cmsRevision).toHaveLength(1); expect(db.rows().auditLog).toHaveLength(1);
    expect(db.locks.some(s => s.includes('"CmsDataset"') && s.includes("FOR UPDATE"))).toBe(true);
    expect(db.locks.some(s => s.includes('"User"') && s.includes("FOR SHARE"))).toBe(true);
    db.revoke(); await expect(importSanity(options())).rejects.toMatchObject({ code: "denied" });
  });
  it.each(["starter", "pro", "unknown"])("denies %s without acquiring locks or writing", async plan => {
    const db = database(); db.setPlan(plan); await source([document()]);
    await expect(importSanity(options())).rejects.toMatchObject({ code: "denied" });
    expect(db.locks).toEqual([]); expect(db.rows().cmsDocument).toEqual([]);
  });
  it("rechecks actor policy after acquiring scoped locks", async () => {
    const db = database(); db.revokeAtLock(); await source([document()]);
    await expect(importSanity(options())).rejects.toMatchObject({ code: "denied" }); expect(db.rows().cmsRevision).toEqual([]);
  });
  it.each(["cmsRevision", "cmsReference", "cmsMutation", "auditLog", "cas"])("rolls back all envelopes/receipts/edges on %s failure", async stage => {
    const db = database(), body = document();
    (body.sections[0].body[0].children as any).push({ _type: "reference", _key: "weak", _ref: "missing", _weak: true });
    await source([body]); if (stage === "cas") db.casMiss(); else db.fail(stage);
    await expect(importSanity(options())).rejects.toMatchObject({ code: stage === "cas" ? "conflict" : "unavailable" });
    for (const rows of Object.values(db.rows())) expect(rows).toEqual([]);
  });
  it("detects changed-source existing-identity conflicts and preserves the original", async () => {
    const db = database(); await source([document()]); await importSanity(options());
    const body = document(); body._rev = "different"; await source([body]);
    await expect(importSanity(options())).rejects.toMatchObject({ code: "conflict" });
    expect(db.rows().cmsRevision).toHaveLength(1); expect(db.rows().cmsMutation).toHaveLength(1);
  });
  it("rejects more than 100 drafts before any database call", async () => {
    await source(Array.from({ length: 101 }, (_, i) => document(`drafts.${i}`)));
    await expect(importSanity(options())).rejects.toMatchObject({ code: "atomic_batch_limit" }); expect(m.getDb).not.toHaveBeenCalled();
  });
  it("Scale uses the same reviewed registered schemas without bypassing unknowns", async () => {
    const db = database(); db.setPlan("enterprise-sla"); await source([document(), { ...document("drafts.other"), _type: "unregistered" }]);
    expect(await importSanity(options())).toMatchObject({ applied: 1, counts: { quarantined: 1 } });
    expect(db.rows().cmsDocument).toHaveLength(1);
  });
  it("resolves forward/cyclic exact references after allocating both envelopes", async () => {
    const db = database(), a = document("drafts.a"), b = document("drafts.b");
    for (const [body, target] of [[a, "drafts.b"], [b, "drafts.a"]] as const) (body.sections[0].body[0].children as any).push({ _type: "reference", _key: "ref", _ref: target });
    await source([a, b]); expect((await importSanity(options())).applied).toBe(2);
    expect(db.rows().cmsReference.map(e => e.state)).toEqual(["resolved", "resolved"]);
    for (const edge of db.rows().cmsReference) expect(db.rows().cmsDocument.find(d => d.id === edge.targetDocumentId)?.nativeId).toBe(edge.sourceRef);
  });
  it.each([undefined, "false", "TRUE"])("dry-run never connects or writes without DB configuration and write rollout %s", async value => {
    vi.stubEnv("DATABASE_URL", ""); vi.stubEnv("JONGO_CMS_WRITES_ENABLED", value); await source([document()]);
    const bytes = await readFile(file);
    expect(await importSanity({ file, datasetId, actorId, apply: false })).toMatchObject({ mode: "dry-run", snapshot: { sha256: sha256(bytes) } });
    expect(m.getDb).not.toHaveBeenCalled(); expect(await readFile(file)).toEqual(bytes);
  });
});