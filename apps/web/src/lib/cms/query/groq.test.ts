import { describe, expect, it } from "vitest";
import { CmsQueryError, runGroq, validateQueryInput, type CmsQueryDocument, type RunGroqInput } from "./groq";
import { createSchemaRegistry, defineField, defineType } from "../schema";
import { cmsSchemaRegistry } from "../schemas";

const stamp = { _rev: "r", _createdAt: "2026-01-01T00:00:00Z", _updatedAt: "2026-01-02T00:00:00Z" };
const doc = (_id: string, _type: string, fields: Record<string, unknown> = {}): CmsQueryDocument => ({ _id, _type, ...stamp, ...fields });

const article = defineType({
  name: "article", type: "document", schemaVersion: 1,
  fields: [
    defineField({ name: "title", type: "string" }),
    defineField({ name: "rank", type: "number" }),
    defineField({ name: "slug", type: "slug" }),
    defineField({ name: "author", type: "reference", to: ["author"] }),
    defineField({ name: "internalNote", type: "string", private: true }),
    defineField({ name: "tags", type: "array", of: [{ type: "string" }] }),
    defineField({ name: "meta", type: "object", fields: [
      { name: "label", type: "string" },
      { name: "reviewer", type: "string", private: true }
    ] }),
    defineField({ name: "blocks", type: "array", keyed: true, of: [
      { type: "object", objectType: "callout", fields: [
        { name: "text", type: "string" }, { name: "evidence", type: "string", private: true }
      ] },
      { type: "object", objectType: "quote", fields: [{ name: "text", type: "string" }] }
    ] }),
    defineField({ name: "body", type: "portableText" })
  ]
});
const author = defineType({
  name: "author", type: "document", schemaVersion: 1,
  fields: [defineField({ name: "name", type: "string" }), defineField({ name: "email", type: "string", private: true })]
});
const registry = createSchemaRegistry([article, author]);

const base: CmsQueryDocument[] = [
  doc("a1", "article", { title: "A published", rank: 2, author: { _type: "reference", _ref: "au1" } }),
  doc("drafts.a1", "article", { title: "A draft", rank: 2, author: { _type: "reference", _ref: "au1" } }),
  doc("drafts.b1", "article", { title: "B draft only", rank: 3 }),
  doc("c1", "article", { title: "C published only", rank: 1, author: { _type: "reference", _ref: "missing" } }),
  doc("au1", "author", { name: "Ada", email: "ada@private.example" })
];
const run = (query: string, extra: Partial<RunGroqInput> = {}) =>
  runGroq({ documents: base, query, registry, consumer: "editor", ...extra });
const rejects = async (promise: Promise<unknown>, code: string) =>
  expect(await promise.then(() => null, (e) => e)).toMatchObject({ name: "CmsQueryError", code });

describe("perspectives", () => {
  const ids = async (perspective: RunGroqInput["perspective"]) =>
    (await run('*[_type == "article"]._id | order(@)', { perspective })).result;
  it("published returns only non-draft documents", async () => {
    expect(await ids("published")).toEqual(["a1", "c1"]);
    expect((await run('*[_id == "a1"][0].title', { perspective: "published" })).result).toBe("A published");
  });
  it("defaults to published", async () => {
    expect((await run('*[_type == "article"]._id | order(@)')).result).toEqual(["a1", "c1"]);
  });
  it("previewDrafts overrides published, strips the drafts. prefix and keeps draft-only documents", async () => {
    expect(await ids("previewDrafts")).toEqual(["a1", "b1", "c1"]);
    expect((await run('*[_id == "a1"][0].title', { perspective: "previewDrafts" })).result).toBe("A draft");
    expect((await run('count(*[_id match "drafts.*"])', { perspective: "previewDrafts" })).result).toBe(0);
  });
  it("raw exposes every variant unchanged", async () => {
    expect(await ids("raw")).toEqual(["a1", "c1", "drafts.a1", "drafts.b1"]);
    expect((await run('*[_id == "drafts.a1"][0].title', { perspective: "raw" })).result).toBe("A draft");
  });
  it("draft replaces its published sibling without merging fields", async () => {
    const documents = [doc("x", "article", { title: "pub", rank: 9 }), doc("drafts.x", "article", { title: "draft" })];
    const { result } = await runGroq({ documents, registry, consumer: "editor", perspective: "previewDrafts", query: "*[_id == 'x'][0]{title, rank}" });
    expect(result).toEqual({ title: "draft", rank: null });
  });
  it("hides release versions outside raw", async () => {
    const documents = [doc("versions.r.x", "article", { title: "rel" }), doc("x", "article", { title: "p" })];
    for (const perspective of ["published", "previewDrafts"] as const) {
      expect((await runGroq({ documents, registry, consumer: "editor", perspective, query: "*._id" })).result).toEqual(["x"]);
    }
    expect((await runGroq({ documents, registry, consumer: "editor", perspective: "raw", query: "count(*)" })).result).toBe(2);
  });
  it("does not mutate the supplied documents", async () => {
    const before = structuredClone(base);
    await run("*", { perspective: "previewDrafts" }); await run("*", { consumer: "public" });
    expect(base).toEqual(before);
  });
  it("rejects an unknown perspective", async () => {
    await rejects(run("*", { perspective: "everything" as never }), "invalid_perspective");
  });
});

describe("dereference", () => {
  it("resolves inside the dataset and respects the perspective", async () => {
    const { result } = await run('*[_id == "a1"][0].author->name', { perspective: "published" });
    expect(result).toBe("Ada");
  });
  it("broken and foreign references are null", async () => {
    expect((await run('*[_id == "c1"][0].author->name')).result).toBeNull();
    const documents = [doc("p", "article", { author: { _type: "reference", _ref: "other-dataset-doc" } })];
    expect((await runGroq({ documents, registry, consumer: "editor", query: "*[0].author->" })).result).toBeNull();
  });
  it("does not resolve a draft target from the published perspective", async () => {
    const documents = [
      doc("p", "article", { author: { _type: "reference", _ref: "d1" } }),
      doc("drafts.d1", "author", { name: "Draft author" })
    ];
    const input = { documents, registry, consumer: "editor" as const, query: '*[_id == "p"][0].author->name' };
    expect((await runGroq({ ...input, perspective: "published" })).result).toBeNull();
    expect((await runGroq({ ...input, perspective: "previewDrafts" })).result).toBe("Draft author");
    expect((await runGroq({ ...input, perspective: "raw" })).result).toBeNull();
  });
  it("a reference to drafts.x resolves only in raw", async () => {
    const documents = [doc("p", "article", { author: { _type: "reference", _ref: "drafts.d1" } }), doc("drafts.d1", "author", { name: "N" })];
    const q = { documents, registry, consumer: "editor" as const, query: "*[_id == 'p'][0].author->name" };
    expect((await runGroq({ ...q, perspective: "raw" })).result).toBe("N");
    expect((await runGroq({ ...q, perspective: "previewDrafts" })).result).toBeNull();
  });
  it("dereferenced documents are privacy filtered for public consumers", async () => {
    const { result } = await run('*[_id == "a1"][0].author->', { consumer: "public" });
    expect(result).toMatchObject({ name: "Ada" });
    expect(JSON.stringify(result)).not.toContain("ada@private.example");
  });
});

describe("query features", () => {
  it("projections, joins, order, slice, count and params", async () => {
    expect((await run('*[_type == "article" && rank >= $min] | order(rank desc){title, "who": author->name}[0...2]', { perspective: "previewDrafts", params: { min: 2 } })).result)
      .toEqual([{ title: "B draft only", who: null }, { title: "A draft", who: "Ada" }]);
    expect((await run('count(*[_type == $t])', { params: { t: "article" } })).result).toBe(2);
    expect((await run('*[_type == "author"]{"ids": *[_type == "article" && references(^._id)]._id}', { perspective: "raw" })).result)
      .toEqual([{ ids: ["a1", "drafts.a1"] }]);
  });
  it("coalesce, defined and select", async () => {
    const { result } = await run('*[_type == "article"] | order(_id){"t": coalesce(author->name, "anon"), "d": defined(author), "s": select(rank > 1 => "hi", "lo")}');
    expect(result).toEqual([{ t: "Ada", d: true, s: "hi" }, { t: "anon", d: true, s: "lo" }]);
  });
  it("returns null for scalars that do not exist, and JSON-detached results", async () => {
    expect((await run("*[_id == 'nope'][0]")).result).toBeNull();
    const out = await run("*[_id == 'a1'][0]");
    expect(out).toMatchObject({ documentCount: 3, ms: expect.any(Number) });
  });
});

describe("private field leakage", () => {
  const secret = "TOP-SECRET";
  const documents: CmsQueryDocument[] = [
    doc("s1", "article", {
      title: "T", internalNote: secret, undeclared: secret, _system: { base: secret },
      meta: { label: "L", reviewer: secret, extra: secret },
      tags: ["a", "b"],
      blocks: [
        { _type: "callout", _key: "k1", text: "hi", evidence: secret },
        { _type: "unknown", _key: "k2", text: secret },
        { _type: "quote", _key: "k3", text: "q", evidence: secret }
      ],
      body: [{ _type: "block", _key: "b", children: [{ _type: "span", text: "pt" }] }],
      author: { _type: "reference", _ref: "au1", _weak: true, leak: secret }
    }),
    doc("au1", "author", { name: "Ada", email: secret }),
    doc("u1", "unregistered", { title: secret })
  ];
  const text = async (query: string, consumer?: RunGroqInput["consumer"]) =>
    JSON.stringify((await runGroq({ documents, registry, query, consumer, perspective: "raw" })).result);

  it.each(["*", "*[_id == 's1']", "*[_id == 's1'][0]{...}", "*[_id == 's1'][0]{..., 'x': 1}", "*[_id == 's1'][0].meta",
    "*[_id == 's1'][0].blocks", "*[_id == 's1'][0]{meta{...}, blocks[]{...}}", "*[_id == 's1'][0].author->",
    "*[_id == 's1'][0]{'n': internalNote, 'r': meta.reviewer, 'e': email}", "*[_id == 'au1'][0]", "*[_type == 'unregistered']",
    "*[_id == 's1'][0].blocks[0].evidence"])("hides private and undeclared data from public consumers: %s", async (query) => {
    expect(await text(query)).not.toContain(secret);
  });
  it("defaults to the most restrictive consumer", async () => {
    const out = JSON.stringify((await runGroq({ documents, registry, query: "*" })).result);
    expect(out).not.toContain(secret);
  });
  it("keeps public data, keys and typed members", async () => {
    const out = (await runGroq({ documents, registry, query: "*[_id == 's1'][0]", perspective: "raw" })).result as Record<string, any>;
    expect(out).toMatchObject({ _id: "s1", _type: "article", title: "T", tags: ["a", "b"], meta: { label: "L" },
      author: { _type: "reference", _ref: "au1", _weak: true } });
    expect(out.blocks).toEqual([{ _type: "callout", _key: "k1", text: "hi" }, { _type: "quote", _key: "k3", text: "q" }]);
    expect(out.body).toHaveLength(1);
    expect(out).not.toHaveProperty("_system");
  });
  it("editor consumers see everything including unregistered types", async () => {
    const out = await text("*", "editor");
    expect(out).toContain(secret);
    expect(await text("count(*)", "editor")).toBe("3");
  });
  it("excludes unregistered types for public consumers", async () => {
    expect(await text("count(*)")).toBe("2");
  });
  it("strips private registry fields (agencyWork consent / provenance)", async () => {
    const docs = [doc("w1", "agencyWork", {
      clientName: "C", category: "x", tone: "sage", services: ["s"], headline: "h", detailSummary: "d",
      provenance: { source: secret }, publicationApproval: { status: "approved", evidence: secret }
    })];
    const out = JSON.stringify((await runGroq({ documents: docs, query: "*" })).result);
    expect(out).toContain('"clientName":"C"');
    expect(out).not.toContain(secret);
    expect(JSON.stringify((await runGroq({ documents: docs, query: "*", consumer: "editor" })).result)).toContain(secret);
    expect(cmsSchemaRegistry.get("agencyWork")).toBeDefined();
  });
});

describe("limits and typed errors", () => {
  it.each([undefined, null, 5, "", "   ", {}])("rejects non-string/empty query %j", async (query) => {
    await rejects(run(query as never), "invalid_query");
  });
  it("rejects an over-long query", async () => {
    await rejects(run("*[_type == 'article']", { limits: { maxQueryLength: 5 } }), "query_too_long");
    await rejects(run("a".repeat(10_001)), "query_too_long");
  });
  it("rejects more documents than the limit, never truncating", async () => {
    await rejects(run("count(*)", { limits: { maxDocuments: 4 } }), "too_many_documents");
    expect((await run("count(*)", { limits: { maxDocuments: 5 }, perspective: "raw" })).result).toBe(5);
  });
  it("rejects oversized results", async () => {
    await rejects(run("*", { perspective: "raw", limits: { maxResultBytes: 100 } }), "result_too_large");
  });
  it("rejects oversized params", async () => {
    await rejects(run("$a", { params: { a: "x".repeat(200) }, limits: { maxParamsBytes: 100 } }), "params_too_large");
  });
  it("rejects invalid or excessive limit overrides", async () => {
    for (const limits of [{ maxDocuments: 0 }, { timeoutMs: 1.5 }, { maxResultBytes: 1e12 }, { maxQueryLength: -1 }, { timeoutMs: "5" }]) {
      await rejects(run("*", { limits: limits as never }), "invalid_options");
    }
  });
  it("enforces the time budget for async work and reports a typed error", async () => {
    const documents = Array.from({ length: 3000 }, (_, i) => doc(`d${i}`, "article", { rank: i, author: { _type: "reference", _ref: `d${(i + 1) % 3000}` } }));
    await rejects(runGroq({ documents, registry, consumer: "editor", limits: { timeoutMs: 1 },
      query: "*[_type == 'article']{'a': author->author->author->rank}" }), "timeout");
  });
  it("rejects invalid documents", async () => {
    for (const documents of [null, [null], [{ _type: "a" }], [{ _id: "x" }], [{ _id: "drafts.", _type: "a" }],
      [doc("x", "a"), doc("x", "a")], ["str"]]) {
      await rejects(runGroq({ documents: documents as never, query: "*", registry }), "invalid_documents");
    }
  });
  it("returns parse errors with message and position but never document content", async () => {
    const error: CmsQueryError = await run("*[_type == ").then(() => null as never, (e) => e);
    expect(error).toBeInstanceOf(CmsQueryError);
    expect(error.code).toBe("invalid_query");
    expect(typeof error.position).toBe("number");
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.message).not.toContain("ada@private.example");
    expect(error).not.toHaveProperty("cause");
    expect(error.stack ?? "").not.toContain("groq-js");
  });
  it("reports an unknown function as invalid_query", async () => {
    const error: CmsQueryError = await run("nope::fn()").then(() => null as never, (e) => e);
    expect(error.code).toBe("invalid_query");
  });
  it("sanitizes runtime failures to a fixed message", async () => {
    const documents = [doc("x", "article", { hasOwnProperty: "TOP-SECRET-SHADOW" })];
    const error = await runGroq({ documents, registry, consumer: "editor", query: "*[0].title" }).then(() => null, (e) => e);
    expect(error).toMatchObject({ code: "evaluation_failed", message: "Query evaluation failed." });
    expect(`${error.message}${error.stack}`).not.toContain("TOP-SECRET-SHADOW");
  });
});

describe("params validation", () => {
  const bad: Array<[string, unknown]> = [
    ["function", { f: () => 1 }], ["symbol", { s: Symbol("x") }], ["bigint", { b: 1n }], ["undefined member", { u: undefined }],
    ["NaN", { n: NaN }], ["Infinity", { n: Infinity }], ["Date", { d: new Date() }], ["Map", { m: new Map() }],
    ["class instance", { c: new (class X { a = 1 })() }], ["array root", [1]], ["string root", "x"],
    ["bad name", { "a-b": 1 }], ["__proto__ key", JSON.parse('{"__proto__": {"x": 1}}')],
    ["nested __proto__", { a: JSON.parse('{"__proto__": 1}') }],
    ["getter", Object.defineProperty({}, "g", { enumerable: true, get: () => 1 })],
    ["symbol key", { [Symbol("k")]: 1 }], ["too deep", (() => { let v: unknown = 1; for (let i = 0; i < 40; i++) v = { v }; return { v }; })()]
  ];
  it.each(bad)("rejects %s", async (_name, params) => {
    await rejects(run("$a", { params: params as never }), "invalid_params");
  });
  it("treats hostile string params as data, never as query text", async () => {
    const payload = '" || true || "';
    expect((await run("count(*[title == $t])", { params: { t: payload }, perspective: "raw" })).result).toBe(0);
    expect((await run("$t", { params: { t: "*[true]" } })).result).toBe("*[true]");
  });
  it("detaches params from the caller's object", async () => {
    const params = { list: ["a"] };
    const out = validateQueryInput({ query: "*", params });
    expect(out.params).toEqual(params);
    expect(out.params.list).not.toBe(params.list);
  });
  it("accepts nested JSON values", async () => {
    expect((await run("$a.b[1]", { params: { a: { b: [1, 2] } } })).result).toBe(2);
  });
});
