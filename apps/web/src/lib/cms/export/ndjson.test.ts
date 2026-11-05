import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readNdjson, READER_LIMITS, sha256, type SourceRecord } from "../import/reader";
import { canonical, planImport } from "../import/planner";
import { runGroq, type CmsQueryDocument, type CmsQueryPerspective } from "../query/groq";
import {
  CmsNdjsonError, isSecretKey, NDJSON_DEFAULT_LIMITS, NDJSON_FORMAT, NDJSON_LIMIT_CEILINGS, NEVER_EXPORT_TYPES,
  parseNdjson, parseNdjsonAsync, serializeNdjson, streamNdjson, toQueryDocuments, verifyNdjson,
  type NdjsonManifest, type NdjsonSerializeOptions
} from "./ndjson";

const NOW = "2026-11-04T12:00:00.000Z";
const stamp = { _createdAt: "2026-01-01T00:00:00.000Z", _updatedAt: "2026-02-03T04:05:06.789Z" };
const d = (id: string, type: string, extra: Record<string, unknown> = {}): CmsQueryDocument =>
  ({ _id: id, _type: type, _rev: `rev-${id}`, ...stamp, ...extra });
const PRIVATE = "PRIVATE_EVIDENCE";
const UNICODE = "pair \u{1F600} \u{1D4B3} sep\u2028para\u2029nel\u0085 caf\u00e9 \u65e5\u672c\u8a9e \\u0041 \"q\" back\\slash\ttab\nnewline";
const LONG = "x".repeat(99_000);
const ref = (to: string, extra: Record<string, unknown> = {}) => ({ _type: "reference", _ref: to, ...extra });

const portableText = () => [
  { _type: "block", _key: "b1", style: "blockquote2", markDefs: [
    { _type: "link", _key: "l1", href: "https://example.com/?a=1&b=2" }, { _type: "textColor", _key: "c1", color: "lime" }
  ], children: [
    { _type: "span", _key: "s1", text: "Hello ", marks: [] },
    { _type: "span", _key: "s2", text: "bold \u{1F600}", marks: ["strong", "l1"] },
    { _type: "span", _key: "s3", text: UNICODE, marks: ["c1", "em"] }
  ] },
  { _type: "block", _key: "b2", listItem: "number", level: 2, markDefs: [], children: [{ _type: "span", _key: "s4", text: "item", marks: [] }] },
  { _type: "callout", _key: "cb", tone: "warn", content: [{ _type: "block", _key: "x", markDefs: [], children: [{ _type: "span", _key: "y", text: "nested", marks: [] }] }] },
  { _type: "image", _key: "im", asset: ref("image-abc-100x100-png", { _weak: true }), alt: "Alt", hotspot: { _type: "sanity.imageHotspot", x: 0.5, y: 0.5, width: 0.2, height: 0.2 } }
];
const articleFields = (title: string) => ({
  slug: { _type: "slug", current: "hello-world" }, title, excerpt: "Excerpt", body: portableText(),
  cover: { _type: "mediaImage", asset: ref("image-abc-100x100-png", { _weak: true }), alt: "Cover" }
});
const storyFields = (extra: Record<string, unknown> = {}) => ({ company: "Acme", personName: "Pat", role: "CEO", quote: "Great.", tone: "lime", ...extra });
const workFields = () => ({ clientName: "Acme", category: "Web", tone: "sage", services: ["a", "b"], headline: "Headline", detailSummary: "One. Two." });

/** Paired draft+published, draft-only, published-only, dangling weak ref, PT, slugs, unicode, long strings, nested _key arrays. */
function dataset(): CmsQueryDocument[] {
  return [
    d("work-1", "agencyWork", { ...workFields(), gallery: [{ _type: "mediaImage", _key: "g1", asset: ref("image-abc-100x100-png"), alt: "x" }] }),
    d("story-dangling", "partnerStories", storyFields({ relatedWork: ref("does-not-exist", { _weak: true }) })),
    d("drafts.story-1", "partnerStories", storyFields({ relatedWork: ref("work-1"), consent: { status: "approved", evidence: PRIVATE, quote: true, likeness: true } })),
    d("note-unicode", "note", {
      text: UNICODE, long: LONG, "\u043a\u043b\u044e\u0447": "\u0437\u043d\u0430\u0447\u0435\u043d\u0438\u0435", "": "empty key",
      items: [
        { _key: "k1", _type: "item", n: 1.5, big: Number.MAX_SAFE_INTEGER, neg: -3, tiny: 1e-7, nul: null, yes: true, no: false },
        { _key: "k2", _type: "item", empty: {}, list: [] }
      ]
    }),
    d("drafts.article-2", "article", articleFields("Draft only")),
    d("drafts.article-1", "article", { ...articleFields("Draft title"), provenance: { source: "PRIVATE_SOURCE" } }),
    d("article-1", "article", articleFields("Published title"))
  ];
}
const RAW_ORDER = ["article-1", "drafts.article-1", "drafts.article-2", "note-unicode", "drafts.story-1", "story-dangling", "work-1"];
const raw = (extra: Partial<NdjsonSerializeOptions> = {}): NdjsonSerializeOptions => ({ exportedAt: NOW, perspective: "raw", includePrivate: true, ...extra });
const text = (bytes: Buffer) => bytes.toString("utf8");
const lines = (bytes: Buffer) => text(bytes).split("\n").slice(0, -1);
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
function shuffled<T>(items: T[]): T[] {
  // Fixed permutation, not random: failures must be reproducible.
  return items.map((item, index) => [item, (index * 5 + 3) % items.length] as const).sort((a, b) => a[1] - b[1]).map(([item]) => item);
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
function thrown(run: () => unknown): CmsNdjsonError {
  try { run(); } catch (error) { expect(error).toBeInstanceOf(CmsNdjsonError); return error as CmsNdjsonError; }
  throw new Error("expected CmsNdjsonError");
}
const code = (run: () => unknown) => thrown(run).code;

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "cms-ndjson-generated-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("serializeNdjson format", () => {
  it("emits Sanity-shaped lines: UTF-8, no BOM, LF only, trailing newline, full envelope", () => {
    const { bytes, manifest } = serializeNdjson(dataset(), raw());
    expect(bytes[0]).not.toBe(0xef);
    expect(bytes[bytes.length - 1]).toBe(10);
    expect(text(bytes)).not.toContain("\r");
    expect(lines(bytes)).toHaveLength(7);
    expect(manifest.documentCount).toBe(7);
    for (const line of lines(bytes)) {
      const doc = JSON.parse(line);
      for (const key of ["_id", "_type", "_rev", "_createdAt", "_updatedAt"]) expect(typeof doc[key]).toBe("string");
    }
  });
  it("orders by logical id, then variant, and keeps the drafts. prefix", () => {
    const { bytes } = serializeNdjson(dataset(), raw());
    expect(lines(bytes).map((line) => JSON.parse(line)._id)).toEqual(RAW_ORDER);
  });
  it("writes sorted keys and escapes characters some line splitters treat as breaks", () => {
    const { bytes } = serializeNdjson([d("n", "note", { b: 1, a: { z: 1, y: [3, 2, 1] } })], raw());
    expect(text(bytes)).toBe('{"_createdAt":"2026-01-01T00:00:00.000Z","_id":"n","_rev":"rev-n","_type":"note","_updatedAt":"2026-02-03T04:05:06.789Z","a":{"y":[3,2,1],"z":1},"b":1}\n');
    const out = text(serializeNdjson(dataset(), raw()).bytes);
    for (const unit of ["\u2028", "\u2029", "\u0085"]) expect(out).not.toContain(unit);
    expect(out).toContain("\\u2028");
  });
  it("is stream friendly: one line per chunk, manifest as the return value, validation before the first chunk", () => {
    expect(() => streamNdjson(dataset(), { exportedAt: "yesterday" })).toThrow(CmsNdjsonError);
    const stream = streamNdjson(dataset(), raw());
    const chunks: Buffer[] = [];
    let step = stream.next();
    while (!step.done) { chunks.push(step.value); step = stream.next(); }
    expect(chunks).toHaveLength(7);
    expect(chunks.every((chunk) => chunk[chunk.length - 1] === 10 && chunk.indexOf(10) === chunk.length - 1)).toBe(true);
    const whole = serializeNdjson(dataset(), raw());
    expect(Buffer.concat(chunks).equals(whole.bytes)).toBe(true);
    expect(step.value).toEqual(whole.manifest);
  });
  it("applies perspectives with the query engine's semantics", () => {
    const ids = (perspective: CmsQueryPerspective) => lines(serializeNdjson(dataset(), raw({ perspective })).bytes).map((l) => JSON.parse(l)._id);
    expect(ids("published")).toEqual(["article-1", "note-unicode", "story-dangling", "work-1"]);
    expect(ids("previewDrafts")).toEqual(["article-1", "article-2", "note-unicode", "story-1", "story-dangling", "work-1"]);
    expect(ids("raw")).toEqual(RAW_ORDER);
    const merged = lines(serializeNdjson(dataset(), raw({ perspective: "previewDrafts" })).bytes).map((l) => JSON.parse(l)).find((doc) => doc._id === "article-1");
    expect(merged.title).toBe("Draft title");
  });
  it("never mutates its input", () => {
    const input = deepFreeze(dataset());
    expect(() => serializeNdjson(input, raw())).not.toThrow();
  });
  it("produces an empty file and a verifiable manifest for an empty set", () => {
    const { bytes, manifest } = serializeNdjson([], raw());
    expect(bytes.length).toBe(0);
    expect(manifest).toMatchObject({ documentCount: 0, byteLength: 0, sha256: createHash("sha256").digest("hex") });
    expect(verifyNdjson(bytes, manifest)).toEqual({ ok: true });
    expect(parseNdjson(bytes).documents).toEqual([]);
  });
});

describe("manifest", () => {
  it("describes the export", () => {
    const { bytes, manifest } = serializeNdjson(dataset(), raw());
    expect(manifest).toEqual({
      format: "jongo-ndjson-v1", exportedAt: NOW, perspective: "raw", includePrivate: true, ordering: "logicalId,variant,_id",
      documentCount: 7, byteLength: bytes.length, sha256: sha256(bytes),
      counts: {
        byType: { agencyWork: 1, article: 3, note: 1, partnerStories: 2 },
        byVariant: { published: 4, draft: 3, version: 0 }
      },
      omitted: { excludedType: 0, unregisteredType: 0 }, redactedSecretKeyCount: 0,
      schema: { envelope: "sanity-document-v1", jongoSchemaVersions: { agencyWork: 1, article: 1, partnerStories: 1 }, unregisteredTypes: ["note"] },
      limits: NDJSON_DEFAULT_LIMITS
    });
    expect(NDJSON_FORMAT).toBe("jongo-ndjson-v1");
  });
  it("is deterministic: same input gives the same bytes and sha256 regardless of input order or key order", () => {
    const a = serializeNdjson(dataset(), raw());
    const reordered = shuffled(dataset()).map((doc) => Object.fromEntries(Object.entries(doc).reverse()) as CmsQueryDocument);
    const b = serializeNdjson(reordered, raw());
    expect(b.bytes.equals(a.bytes)).toBe(true);
    expect(b.manifest).toEqual(a.manifest);
    expect(serializeNdjson(dataset(), raw()).manifest.sha256).toBe(a.manifest.sha256);
    expect(serializeNdjson(dataset(), raw({ exportedAt: "2027-01-01T00:00:00.000Z" })).manifest.sha256).toBe(a.manifest.sha256);
  });
});

describe("round trip", () => {
  it("serialize -> parse deep-equals the original for every document shape", () => {
    const original = dataset();
    const { bytes } = serializeNdjson(shuffled(original), raw());
    const parsed = parseNdjson(bytes);
    expect(parsed.documents.map((doc) => doc._id)).toEqual(RAW_ORDER);
    expect(parsed.stats).toMatchObject({ records: 7, blanks: 0, bytes: bytes.length, sha256: sha256(bytes) });
    const byId = new Map(original.map((doc) => [doc._id, doc]));
    for (const doc of parsed.documents) expect(plain(doc)).toStrictEqual(byId.get(doc._id));
  });
  it("preserves unicode: surrogate pairs, U+2028, U+2029, U+0085, escapes, long strings, key order inside arrays", () => {
    const note = parseNdjson(serializeNdjson(dataset(), raw()).bytes).documents.find((doc) => doc._id === "note-unicode")!;
    expect(note.text).toBe(UNICODE);
    expect(note.long).toBe(LONG);
    expect((note.items as any[]).map((item) => item._key)).toEqual(["k1", "k2"]);
    expect((note.items as any[])[0]).toMatchObject({ n: 1.5, big: Number.MAX_SAFE_INTEGER, tiny: 1e-7, nul: null });
    expect(note[""]).toBe("empty key");
  });
  it("reads a Sanity-style file with raw U+2028 and CRLF/BOM exactly like the importer reader", () => {
    const rawLine = `{"_id":"a","_type":"t","text":"x\u2028y"}`;
    const bytes = Buffer.from(`\ufeff${rawLine}\r\n\r\n{"_id":"b","_type":"t"}`);
    const parsed = parseNdjson(bytes);
    expect(parsed.documents.map((doc) => doc.text)).toEqual(["x\u2028y", undefined]);
    expect(parsed.stats).toMatchObject({ records: 2, blanks: 1 });
  });

  // GROQ's order for an unordered `*` is unspecified, so every multi-document query sorts explicitly.
  const queries = [
    "count(*)",
    "*[_type == 'article'] | order(_id) {_id, title, 'slug': slug.current}",
    "*[_type == 'article'] | order(_id) {_id, 'text': body[_type == 'block'].children[].text}",
    "*[_type == 'article'] | order(_id) {_id, 'keys': body[]._key, 'defs': body[0].markDefs}",
    "*[_type == 'partnerStories'] | order(_id) {_id, company, 'work': relatedWork->headline, 'consent': consent.evidence}",
    "*[_type == 'note'][0]{text, long, items}",
    "*[references('work-1')]._id | order(@)",
    "*[_type == 'agencyWork'][0].gallery[]._key",
    "*[_id in path('drafts.**')]._id | order(@)",
    "*[] | order(_id)"
  ];
  const perspectives: CmsQueryPerspective[] = ["published", "previewDrafts", "raw"];
  const run = (documents: CmsQueryDocument[], query: string, perspective: CmsQueryPerspective, consumer: "editor" | "public") =>
    runGroq({ documents, query, perspective, consumer }).catch((error) => { throw new Error(`${query} -> ${error.code} ${error.message}`); });
  it.each(perspectives)("GROQ results are identical before and after export (%s, editor and public views)", async (perspective) => {
    const original = dataset();
    const reparsed = toQueryDocuments(parseNdjson(serializeNdjson(original, raw()).bytes).documents);
    for (const consumer of ["editor", "public"] as const) {
      for (const query of queries) {
        const before = await run(original, query, perspective, consumer);
        const after = await run(reparsed, query, perspective, consumer);
        expect(after.result, `${consumer}: ${query}`).toStrictEqual(before.result);
        expect(after.documentCount).toBe(before.documentCount);
      }
    }
  });
  it.each(perspectives)("a public export answers public queries like the live data (%s)", async (perspective) => {
    const original = dataset();
    const reparsed = toQueryDocuments(parseNdjson(serializeNdjson(original, { exportedAt: NOW, perspective: "raw" }).bytes).documents);
    for (const query of queries) {
      const before = await run(original, query, perspective, "public");
      const after = await run(reparsed, query, perspective, "public");
      expect(after.result, query).toStrictEqual(before.result);
    }
  });
});

describe("existing importer compatibility (dry-run plan, no DB)", () => {
  // Only Portable Text the importer's registered schema supports: no custom blocks.
  const supported = (title: string) => ({ ...articleFields(title), body: portableText().slice(0, 2) });
  const registered = () => [
    d("drafts.work-1", "agencyWork", workFields()),
    d("drafts.story-1", "partnerStories", storyFields({ relatedWork: ref("drafts.work-1"), consent: { status: "approved", evidence: PRIVATE, reviewer: "R", approvedAt: "2026-01-01T00:00:00Z", quote: true, likeness: true } })),
    d("drafts.article-1", "article", supported("Draft title")),
    d("article-1", "article", supported("Published title"))
  ];
  async function plan(bytes: Buffer) {
    const file = join(directory, "data.ndjson");
    await writeFile(file, bytes);
    return planImport(file);
  }
  it("accepts exported registered drafts and quarantines the published variant, with exact counts", async () => {
    const original = registered();
    const { bytes, manifest } = serializeNdjson(original, raw());
    const result = await plan(bytes);
    expect(result.report.counts).toEqual({ eligible: 3, quarantined: 1, excluded_secret: 0, excluded_operational: 0 });
    expect({ ...result.report.reasons }).toEqual({ eligible: 3, published_variant_unsupported: 1 });
    expect(result.snapshot).toMatchObject({ bytes: manifest.byteLength, sha256: manifest.sha256, records: 4, blanks: 0 });
    expect(result.candidates.map((c) => c.value._id)).toEqual(["drafts.article-1", "drafts.story-1", "drafts.work-1"]);
    // The planner's canonical payload hash of each candidate equals that of the original document.
    const byId = new Map(original.map((doc) => [doc._id, doc]));
    for (const candidate of result.candidates) expect(candidate.payloadSha256).toBe(sha256(canonical(byId.get(candidate.value._id as string) as never)));
    expect(result.report.publishable).toBe(false);
  });
  it("a public export of the same drafts is still accepted (private fields are optional for drafts)", async () => {
    const { bytes } = serializeNdjson(registered(), { exportedAt: NOW, perspective: "raw" });
    expect(text(bytes)).not.toContain(PRIVATE);
    expect((await plan(bytes)).report.counts).toMatchObject({ eligible: 3, quarantined: 1 });
  });
  it("secret/operational types never reach the planner; unregistered types are quarantined, not dropped, with includePrivate", async () => {
    const input = [...registered(), d("note-1", "note", { text: "hi" }), d("k", "mux.apiKey", { apiKey: "SECRET_API" }), d("p", "pageNotFound", { url: "/x" }), d("n", "notificationRequest", {})];
    const { bytes, manifest } = serializeNdjson(input, raw());
    expect(manifest.omitted).toEqual({ excludedType: 3, unregisteredType: 0 });
    expect(text(bytes)).not.toContain("SECRET_API");
    expect((await plan(bytes)).report.counts).toEqual({ eligible: 3, quarantined: 2, excluded_secret: 0, excluded_operational: 0 });
  });
  it("NEVER_EXPORT_TYPES equals the types the planner excludes", async () => {
    const types = [...NEVER_EXPORT_TYPES];
    const file = join(directory, "excluded.ndjson");
    await writeFile(file, types.map((type, i) => JSON.stringify({ _id: `x${i}`, _type: type })).join("\n"));
    const result = await planImport(file);
    expect(result.entries.every((entry) => entry.reason.startsWith("excluded_"))).toBe(true);
    expect(result.entries.map((entry) => entry.type).sort()).toEqual([...types].sort());
    for (const planned of ["mux.apiKey", "pageNotFound", "notificationRequest"]) expect(NEVER_EXPORT_TYPES.has(planned)).toBe(true);
  });
});

describe("privacy and secrets", () => {
  const secrets = () => [
    d("article-1", "article", { ...articleFields("T"), provenance: { source: "PRIVATE_SOURCE" }, publicationApproval: { status: "approved", evidence: PRIVATE } }),
    d("story-1", "partnerStories", storyFields({ consent: { status: "approved", evidence: PRIVATE, quote: true, likeness: true } })),
    d("settings", "siteSettings", {
      title: "Site", mux: { apiKey: "SECRET_API", playbackId: "ok" }, sanityToken: "SECRET_TOKEN",
      nested: [{ _key: "k", password: "SECRET_PW", fine: "yes" }]
    }),
    d("note-1", "note", { text: "hello" }),
    d("mux-key", "mux.apiKey", { secret: "SECRET_DOC" }),
    d("404-1", "pageNotFound", { url: "/x" }),
    d("req-1", "notificationRequest", { email: "SECRET_MAIL" })
  ];
  it("public export strips private and undeclared fields and drops unregistered types", () => {
    const { bytes, manifest } = serializeNdjson(secrets(), { exportedAt: NOW, perspective: "raw" });
    const out = text(bytes);
    for (const marker of [PRIVATE, "PRIVATE_SOURCE", "SECRET_", "consent", "provenance", "siteSettings", "note-1", "mux-key"]) expect(out).not.toContain(marker);
    expect(manifest).toMatchObject({ includePrivate: false, documentCount: 2, omitted: { excludedType: 3, unregisteredType: 2 } });
  });
  it("includePrivate keeps private fields and unregistered types but still never secrets", () => {
    const { bytes, manifest } = serializeNdjson(secrets(), raw());
    const out = text(bytes);
    expect(out).toContain(PRIVATE);
    expect(out).toContain("PRIVATE_SOURCE");
    expect(out).toContain("playbackId");
    expect(out).toContain('"fine":"yes"');
    for (const marker of ["SECRET_", "apiKey", "sanityToken", "password", "mux-key", "404-1", "req-1"]) expect(out).not.toContain(marker);
    expect(manifest).toMatchObject({ includePrivate: true, documentCount: 4, omitted: { excludedType: 3, unregisteredType: 0 }, redactedSecretKeyCount: 3 });
    expect(verifyNdjson(bytes, manifest)).toEqual({ ok: true });
  });
  it("only the boolean true enables includePrivate", () => {
    for (const value of ["true", 1, {}, "yes"]) expect(code(() => serializeNdjson(secrets(), { exportedAt: NOW, includePrivate: value as never }))).toBe("invalid_options");
    expect(serializeNdjson(secrets(), { exportedAt: NOW, perspective: "raw", includePrivate: undefined }).manifest.includePrivate).toBe(false);
  });
  it.each([
    ["apiKey", true], ["mux.apiKey", true], ["API_KEY", true], ["secretAccessKey", true], ["clientSecret", true], ["password", true], ["passwd", true],
    ["privateKey", true], ["sanityToken", true], ["accessToken", true], ["token", true], ["authorization", true], ["credentials", true],
    ["title", false], ["tone", false], ["tokens", false], ["tokenCount", false], ["secretary", false], ["slug", false], ["provenance", false], ["consent", false]
  ])("isSecretKey(%s) = %s", (key, expected) => { expect(isSecretKey(key)).toBe(expected); });
  it("does not read secrets from values (documented limit)", () => {
    const { bytes } = serializeNdjson([d("n", "note", { note: "my password is hunter2" })], raw());
    expect(text(bytes)).toContain("hunter2");
  });
});

describe("serializer limits and typed errors", () => {
  it("caps document count without truncating", () => {
    expect(code(() => serializeNdjson(dataset(), raw({ limits: { maxDocuments: 6 } })))).toBe("too_many_documents");
    expect(serializeNdjson(dataset(), raw({ limits: { maxDocuments: 7 } })).manifest.documentCount).toBe(7);
  });
  it("caps per-line size, reports the id and never echoes content", () => {
    const error = thrown(() => serializeNdjson([d("big", "note", { text: "SECRET_CONTENT".repeat(100) })], raw({ limits: { maxLineBytes: 500 } })));
    expect(error.code).toBe("line_too_large");
    expect(error.documentId).toBe("big");
    expect(error.message).not.toContain("SECRET_CONTENT");
    const wide = d("wide", "note", { a: LONG, b: LONG, c: LONG, d: LONG, e: LONG, f: LONG });
    expect(code(() => serializeNdjson([wide], raw()))).toBe("line_too_large");
  });
  it("caps total output", () => {
    expect(code(() => serializeNdjson(dataset(), raw({ limits: { maxTotalBytes: 1000 } })))).toBe("output_too_large");
  });
  it("defaults equal the importer reader limits; raising past them is possible but the importer reader refuses the result", () => {
    expect(NDJSON_DEFAULT_LIMITS).toEqual({ maxDocuments: READER_LIMITS.records, maxLineBytes: READER_LIMITS.line, maxTotalBytes: READER_LIMITS.file });
    const wide = d("wide", "note", { a: LONG, b: LONG, c: LONG, d: LONG, e: LONG, f: LONG });
    const { bytes } = serializeNdjson([wide], raw({ limits: { maxLineBytes: 1024 * 1024 } }));
    expect(code(() => parseNdjson(bytes))).toBe("line_limit");
    expect(parseNdjson(bytes, { limits: { maxLineBytes: 1024 * 1024 } }).documents).toHaveLength(1);
  });
  it.each([
    [{ maxDocuments: 0 }], [{ maxLineBytes: 1.5 }], [{ maxTotalBytes: NDJSON_LIMIT_CEILINGS.maxTotalBytes + 1 }], [{ maxDocuments: "5" }], [null]
  ])("rejects invalid limits %j", (limits) => {
    expect(code(() => serializeNdjson([], raw({ limits: limits as never })))).toBe("invalid_options");
  });
  it("rejects bad options and perspectives", () => {
    expect(code(() => serializeNdjson([], { exportedAt: "yesterday" }))).toBe("invalid_options");
    expect(code(() => serializeNdjson([], { exportedAt: undefined as never }))).toBe("invalid_options");
    expect(code(() => serializeNdjson([], { exportedAt: NOW, perspective: "bogus" as never }))).toBe("invalid_perspective");
    expect(code(() => serializeNdjson(undefined as never, raw()))).toBe("invalid_document");
  });
  it.each([
    ["missing _rev", () => ({ ...d("a", "t"), _rev: undefined })],
    ["bad timestamp", () => ({ ...d("a", "t"), _updatedAt: "2026-02-30T00:00:00Z" })],
    ["empty draft id", () => d("drafts.", "t")],
    ["non-object", () => 5 as never]
  ])("rejects an invalid envelope: %s", (_name, make) => {
    expect(code(() => serializeNdjson([make() as never], raw()))).toBe("invalid_document");
  });
  it.each([
    ["lone high surrogate", { s: "a\ud800b" }], ["lone low surrogate", { s: "a\udc00" }], ["NUL", { s: "a\u0000" }],
    ["lone surrogate in a key", { "k\ud800": 1 }], ["NaN", { n: NaN }], ["Infinity", { n: Infinity }],
    ["unsafe integer", { n: 2 ** 53 }], ["1e21", { n: 1e21 }], ["undefined", { n: undefined }], ["function", { f: () => 1 }],
    ["bigint", { n: 1n }], ["too-long string", { s: "x".repeat(100_001) }], ["too deep", { a: JSON.parse("[".repeat(40) + "]".repeat(40)) }],
    ["prototype key", JSON.parse('{"__proto__":{"x":1}}')],
    ["raw html block", { body: [{ _type: "html", _key: "k" }] }], ["class instance", { when: new Date() }]
  ])("rejects a value that the reader could not read back: %s", (_name, extra) => {
    const error = thrown(() => serializeNdjson([d("bad", "note", extra as Record<string, unknown>)], raw()));
    expect(error.code).toBe("invalid_document");
    expect(error.documentId).toBe("bad");
  });
  it("rejects accessor properties without invoking them", () => {
    let called = false;
    const doc = d("bad", "note");
    Object.defineProperty(doc, "x", { enumerable: true, get: () => { called = true; return 1; } });
    expect(code(() => serializeNdjson([doc], raw()))).toBe("invalid_document");
    expect(called).toBe(false);
  });
  it("rejects duplicate ids", () => {
    expect(code(() => serializeNdjson([d("a", "t"), d("a", "t")], raw()))).toBe("duplicate_id");
  });
  it("accepts a safe integer at the boundary and a long-but-legal string", () => {
    const { bytes } = serializeNdjson([d("a", "note", { n: Number.MIN_SAFE_INTEGER, s: "x".repeat(100_000) })], raw());
    expect(parseNdjson(bytes).documents[0].n).toBe(Number.MIN_SAFE_INTEGER);
  });
});

describe("parseNdjson aligned with the importer reader", () => {
  const good = () => Buffer.from(`\ufeff${JSON.stringify(d("a", "t", { s: "\u{1F600}" }))}\r\n\t\n${JSON.stringify(d("drafts.b", "t"))}\n\n${JSON.stringify(d("c", "t"))}`);
  it("reads the same records, hash and counts as readNdjson", async () => {
    const bytes = good();
    const file = join(directory, "good.ndjson");
    await writeFile(file, bytes);
    const visited: SourceRecord[] = [];
    const snapshot = await readNdjson(file, (record) => { visited.push(record); });
    const parsed = parseNdjson(bytes);
    expect(parsed.stats).toEqual(snapshot);
    expect(parsed.documents.map(plain)).toEqual(visited.map((record) => plain(record.value)));
  });
  const reps = (n: number) => Array.from({ length: n }, (_, i) => `{"_id":"i${i}","_type":"t"}`).join("\n");
  const cases: Array<[string, Buffer, string]> = [
    ["invalid utf-8", Buffer.concat([Buffer.from('{"_id":"a","_type":"t"}\n'), Buffer.from([0xff])]), "utf8"],
    ["misplaced BOM", Buffer.from('{"_id":"a","_type":"t","x":"\ufeff"}'), "bom"],
    ["duplicate key", Buffer.from('{"_id":"a","_id":"b","_type":"t"}'), "duplicate_key"],
    ["escaped duplicate key", Buffer.from('{"_id":"a","\\u005fid":"b","_type":"t"}'), "duplicate_key"],
    ["__proto__ key", Buffer.from('{"_id":"a","_type":"t","__proto__":{}}'), "unsafe_key"],
    ["nested constructor key", Buffer.from('{"_id":"a","_type":"t","x":{"constructor":1}}'), "unsafe_key"],
    ["trailing comma", Buffer.from('{"_id":"a","_type":"t",}'), "json"],
    ["unsafe integer", Buffer.from('{"_id":"a","_type":"t","n":9007199254740993}'), "number"],
    ["lone surrogate escape", Buffer.from('{"_id":"a","_type":"t","s":"\\ud800"}'), "unicode"],
    ["NUL escape", Buffer.from('{"_id":"a","_type":"t","s":"\\u0000"}'), "unicode"],
    ["too deep", Buffer.from("[".repeat(34) + "0" + "]".repeat(34)), "depth_limit"],
    ["oversized line", Buffer.from("x".repeat(READER_LIMITS.line + 1)), "line_limit"],
    ["too many records", Buffer.from(reps(READER_LIMITS.records + 1)), "record_limit"]
  ];
  it.each(cases)("rejects like the reader: %s", async (_name, bytes, expected) => {
    const file = join(directory, "bad.ndjson");
    await writeFile(file, bytes);
    const reader = await readNdjson(file, () => {}).then(() => null, (error) => error);
    const mine = thrown(() => parseNdjson(bytes));
    expect(reader.code).toBe(expected);
    expect(mine.code).toBe(expected);
    expect(mine.line).toBe(reader.line);
  });
  it("is stricter in exactly two places the planner would reject later: identity and duplicate _id", () => {
    for (const bad of ["[1]", "5", "null", '{"x":1}', '{"_id":"","_type":"t"}', '{"_id":"a","_type":7}', '{"_id":"drafts.","_type":"t"}']) {
      expect(code(() => parseNdjson(Buffer.from(bad)))).toBe("identity");
    }
    expect(code(() => parseNdjson(Buffer.from('{"_id":"a","_type":"t"}\n{"_id":"a","_type":"u"}')))).toBe("duplicate_id");
  });
  it("never echoes content in errors", () => {
    const error = thrown(() => parseNdjson(Buffer.from('{"_id":"a","_type":"t","SECRET_MARKER":')));
    expect(error.message).not.toContain("SECRET_MARKER");
    expect(error.line).toBe(1);
  });
  it("decodes multibyte characters split across arbitrary chunk boundaries", async () => {
    const bytes = serializeNdjson(dataset(), raw()).bytes;
    const oneByte = Array.from(bytes, (byte) => Buffer.from([byte]));
    expect(parseNdjson(oneByte).documents.map(plain)).toEqual(parseNdjson(bytes).documents.map(plain));
    const unescaped = Buffer.from(`{"_id":"a","_type":"t","s":"${"\u{1F600}\u00e9".repeat(50)}"}\n`);
    const split = [unescaped.subarray(0, 40), unescaped.subarray(40, 41), unescaped.subarray(41)];
    expect(parseNdjson(split).documents[0].s).toBe("\u{1F600}\u00e9".repeat(50));
    async function* source() { for (const chunk of split) yield chunk; }
    expect((await parseNdjsonAsync(source())).documents[0].s).toBe("\u{1F600}\u00e9".repeat(50));
    expect((await parseNdjsonAsync(bytes)).documents).toHaveLength(7);
  });
  it("enforces caller limits, which may only be raised to the ceilings", () => {
    const bytes = serializeNdjson(dataset(), raw()).bytes;
    expect(code(() => parseNdjson(bytes, { limits: { maxDocuments: 3 } }))).toBe("record_limit");
    expect(code(() => parseNdjson(bytes, { limits: { maxTotalBytes: 1000 } }))).toBe("file_limit");
    expect(code(() => parseNdjson(bytes, { limits: { maxLineBytes: 100 } }))).toBe("line_limit");
    expect(code(() => parseNdjson(bytes, { limits: { maxDocuments: NDJSON_LIMIT_CEILINGS.maxDocuments + 1 } }))).toBe("invalid_options");
    expect(code(() => parseNdjson("text" as never))).toBe("invalid_options");
    expect(code(() => parseNdjson([Buffer.from("{}"), "x" as never]))).toBe("invalid_options");
  });
  it("returns prototype-less objects so parsed keys cannot pollute", () => {
    const doc = parseNdjson(Buffer.from('{"_id":"a","_type":"t","x":{"y":1}}')).documents[0];
    expect(Object.getPrototypeOf(doc)).toBeNull();
    expect(Object.getPrototypeOf(doc.x)).toBeNull();
  });
});

describe("verifyNdjson tamper detection", () => {
  const make = () => serializeNdjson(dataset(), raw());
  const fails = (bytes: Uint8Array, manifest: NdjsonManifest) => {
    const result = verifyNdjson(bytes, manifest);
    return result.ok ? [] : result.reasons;
  };
  it("accepts an untouched export", () => {
    const { bytes, manifest } = make();
    expect(verifyNdjson(bytes, manifest)).toEqual({ ok: true });
  });
  it("detects a single flipped byte, truncation and appended data", () => {
    const { bytes, manifest } = make();
    const flipped = Buffer.from(bytes); flipped[100] ^= 1;
    expect(fails(flipped, manifest)).toContain("sha256_mismatch");
    expect(fails(bytes.subarray(0, bytes.length - 5), manifest)).toEqual(expect.arrayContaining(["byte_length_mismatch", "sha256_mismatch", "missing_trailing_newline"]));
    expect(fails(Buffer.concat([bytes, Buffer.from('{"_id":"z","_type":"t"}\n')]), manifest)).toEqual(expect.arrayContaining(["sha256_mismatch", "document_count_mismatch"]));
  });
  it("detects a tampered manifest", () => {
    const { bytes, manifest } = make();
    expect(fails(bytes, { ...manifest, sha256: "0".repeat(64) })).toEqual(["sha256_mismatch"]);
    expect(fails(bytes, { ...manifest, byteLength: manifest.byteLength + 1 })).toEqual(["byte_length_mismatch"]);
    expect(fails(bytes, { ...manifest, documentCount: 8 })).toEqual(["document_count_mismatch"]);
    expect(fails(bytes, { ...manifest, counts: { ...manifest.counts, byType: { ...manifest.counts.byType, article: 2 } } })).toEqual(["counts_mismatch"]);
    expect(fails(bytes, { ...manifest, counts: { ...manifest.counts, byVariant: { published: 7, draft: 0, version: 0 } } })).toEqual(["counts_mismatch"]);
    expect(fails(bytes, { ...manifest, format: "other" as never })).toEqual(["format_mismatch"]);
    for (const broken of [null, {}, { ...manifest, sha256: "xyz" }, { ...manifest, byteLength: -1 }, { ...manifest, counts: undefined }]) {
      expect(fails(bytes, broken as never)).toEqual(["manifest_invalid"]);
    }
  });
  it("detects a removed line even when the hash is recomputed to match", () => {
    const { bytes, manifest } = make();
    const smaller = Buffer.from(lines(bytes).slice(1).map((line) => `${line}\n`).join(""));
    const rehashed = { ...manifest, byteLength: smaller.length, sha256: sha256(smaller) };
    expect(fails(smaller, rehashed)).toEqual(expect.arrayContaining(["document_count_mismatch", "counts_mismatch"]));
  });
  it("detects BOM, blank lines and unparseable content", () => {
    const { bytes, manifest } = make();
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]);
    expect(fails(withBom, { ...manifest, byteLength: withBom.length, sha256: sha256(withBom) })).toContain("bom_present");
    const blank = Buffer.concat([bytes, Buffer.from("\n")]);
    expect(fails(blank, { ...manifest, byteLength: blank.length, sha256: sha256(blank) })).toContain("blank_lines");
    const garbage = Buffer.from('{"_id":"a",\n');
    expect(fails(garbage, { ...manifest, byteLength: garbage.length, sha256: sha256(garbage) })).toContain("unparseable:json");
  });
  it("cannot detect a coordinated edit of both file and manifest (documented: the manifest is unsigned)", () => {
    const { bytes, manifest } = make();
    const edited = Buffer.from(text(bytes).replace("Published title", "Published TITLE"));
    expect(verifyNdjson(edited, { ...manifest, byteLength: edited.length, sha256: sha256(edited) })).toEqual({ ok: true });
  });
});
