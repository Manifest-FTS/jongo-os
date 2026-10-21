import { describe, expect, expectTypeOf, it } from "vitest";
import { createSchemaRegistry, defineArrayMember, defineField, defineType, sourceIdentity, validateDocument, type InferDocument, type TypeDefinition } from "./schema";
import { agencyWork, article, cmsSchemaRegistry, cmsSchemas, languageDictionary, LANDING_BLOCK_TOKENS, landingSections, partnerStories, productLanding, signalCaseStudy, testimonial, workCaseStudy, type AgencyWork, type ProductLanding } from "./schemas";
import { inspectJson, isSafeUrl, LIMITS } from "./validation";

const native = (type = "fixture", id = "opaque:record-1.with.punctuation") => ({ _id: id, _type: type, _rev: "opaque-not-a-cas-token!", _createdAt: "2026-01-01T10:20:30.123Z", _updatedAt: "2026-02-01T10:20:30Z" });
const fixture = defineType({ name: "fixture", type: "document", schemaVersion: 1, fields: [
  defineField({ name: "title", type: "text", required: true, minLength: 1, maxLength: 30 }),
  { name: "slug", type: "slug" }, { name: "locale", type: "string" },
  { name: "count", type: "number", min: 0, max: 10, integer: true },
  { name: "enabled", type: "boolean" }, { name: "url", type: "url" },
  { name: "date", type: "date" }, { name: "time", type: "datetime" },
  { name: "tone", type: "enum", options: ["blue", "lime"] },
  { name: "ref", type: "reference", to: ["fixture"] },
  { name: "asset", type: "asset", to: ["sanity.imageAsset"] },
  { name: "items", type: "array", keyed: true, maxItems: 3, of: [defineArrayMember({ type: "object", objectType: "item", fields: [{ name: "label", type: "string", required: true }] })] },
  { name: "body", type: "portableText" }
] });
const registry = createSchemaRegistry([fixture]);
const approval = { status: "approved", reviewer: "sanitized-reviewer", evidence: "Generated approval evidence", approvedAt: "2026-10-01T00:00:00Z" };
const provenance = { source: "Generated fixture, not NCW data" };
const refs = new Map([["image:one", { _type: "sanity.imageAsset" }]]);
const work = () => ({ ...native("agencyWork", "work:one"), clientName: "Example", category: "Web", tone: "sage", services: ["Development"], headline: "An example", detailSummary: "A sourced project.", cardAsset: { _type: "reference", _ref: "image:one" }, provenance, publicationApproval: approval });
const dictionary = () => ({ ...native("languageDictionary", "dictionary:en"), audience: "jongo", locale: "en", version: 1, entries: [{ _type: "dictionaryEntry", _key: "e1", key: "actions.save", value: "", placeholders: [], format: "plain", status: "approved", revision: "opaque" }] });

describe("typed descriptors and pure JSON registry", () => {
  it("infers required/optional fields, enums, native envelopes and discriminated arrays", () => {
    type Doc = InferDocument<typeof fixture>;
    expectTypeOf<Doc["title"]>().toEqualTypeOf<string>();
    expectTypeOf<Doc["count"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<Doc["tone"]>().toEqualTypeOf<"blue" | "lime" | undefined>();
    expectTypeOf<Doc["_type"]>().toEqualTypeOf<"fixture">();
    expectTypeOf<AgencyWork["tone"]>().toEqualTypeOf<"sage" | "blush" | "sand">();
    type Section = ProductLanding["sections"][number];
    expectTypeOf<Extract<Section, { _type: "pricingRef" }>["offerId"]>().toEqualTypeOf<string>();
    expectTypeOf<Section["_key"]>().toEqualTypeOf<string>();
    const doc: Doc = { ...native(), _type: "fixture", title: "valid" };
    expect(validateDocument(doc, registry).valid).toBe(true);
  });
  it("provides frozen JSON descriptors without browser functions or executable validators", () => {
    const json = JSON.stringify(cmsSchemaRegistry.descriptors);
    expect(JSON.parse(json)).toEqual(cmsSchemas);
    expect(inspectJson(cmsSchemaRegistry.descriptors)).toEqual([]);
    expect(Object.isFrozen(cmsSchemaRegistry.descriptors[0].fields)).toBe(true);
    expect(cmsSchemaRegistry.get("agencyWork")).toEqual(agencyWork);
    expect(cmsSchemaRegistry.get("constructor")).toBeUndefined();
  });
  it("rejects duplicate names, fields, callbacks and ambiguous union members", () => {
    expect(() => createSchemaRegistry([fixture, fixture])).toThrow();
    expect(() => createSchemaRegistry([{ ...fixture, fields: [fixture.fields[0], fixture.fields[0]] }])).toThrow();
    expect(() => createSchemaRegistry([{ ...fixture, callback: () => { throw new Error("Never run"); } } as TypeDefinition])).toThrow();
    expect(() => createSchemaRegistry([{ ...fixture, fields: [{ name: "x", type: "array", of: [{ type: "object", fields: [] }, { type: "string" }] }] }])).toThrow();
  });
});

describe("native envelope, identity and no silent loss", () => {
  it("preserves exact opaque IDs/revisions/timestamps without adding slug, locale or native CAS", () => {
    const input = { ...native(), title: "Sample" };
    const before = JSON.stringify(input);
    const output = validateDocument(input, registry);
    expect(output.valid).toBe(true);
    expect(output.source).toBe(input);
    expect(output.value).toEqual(input);
    expect(JSON.stringify(output.source)).toBe(before);
    expect(output.value).not.toHaveProperty("slug");
    expect(output.value).not.toHaveProperty("locale");
    expect(output.value).not.toHaveProperty("lockVersion");
  });
  it("strips exactly one recognized prefix and never synthesizes a published record", () => {
    expect(sourceIdentity("drafts.drafts.a:b")).toEqual({ sourceId: "drafts.drafts.a:b", logicalId: "drafts.a:b", variant: "draft" });
    expect(sourceIdentity("x.drafts.a").logicalId).toBe("x.drafts.a");
    expect(sourceIdentity("drafts.only").variant).toBe("draft");
    expect(sourceIdentity("paired").logicalId).toBe(sourceIdentity("drafts.paired").logicalId);
    const draft = { ...native("fixture", "drafts.only"), title: "x" };
    expect(validateDocument(draft, registry, { mode: "publish" }).findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "draft_variant" })]));
    expect(validateDocument(draft, registry)).toMatchObject({ valid: true, canPublish: false, source: draft, value: draft });
  });
  it.each(["_id", "_type", "_rev", "_createdAt", "_updatedAt"])("diagnoses missing envelope field %s", (field) => {
    const input: Record<string, unknown> = { ...native(), title: "ok" };
    delete input[field];
    const output = validateDocument(input, registry);
    expect(output.valid).toBe(false);
    expect(output.canPublish).toBe(false);
    expect(output.source).toEqual(input);
  });
  it.each([null, [], 5, "document", false, undefined])("does not throw on invalid root %j", (input) => {
    expect(() => validateDocument(input, registry)).not.toThrow();
    expect(validateDocument(input, registry).canPublish).toBe(false);
  });
  it.each(["not-a-date", "2026-02-30T00:00:00Z", "2026-01-01", 10])("does not repair bad source timestamp %s", (time) => {
    expect(validateDocument({ ...native(), title: "ok", _createdAt: time }, registry).findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "timestamp", path: '$["_createdAt"]' })]));
  });
  it("retains unknown types, unknown fields and opaque private system provenance with blocking paths", () => {
    for (const input of [
      { ...native("unknown.legacy"), nested: { empty: "", items: [1, 2] } },
      { ...native(), title: "known", extra: { untouched: true }, _system: { base: { opaque: "https://example.test/not-fetched" } } }
    ]) {
      const output = validateDocument(input, registry);
      expect(output.valid).toBe(true);
      expect(output.canPublish).toBe(false);
      expect(output.value).toBeUndefined();
      expect(output.source).toEqual(input);
      expect(output.findings.every((f) => f.path.startsWith("$"))).toBe(true);
      expect(output.findings.some((f) => f.disposition === "quarantine")).toBe(true);
    }
  });
  it("keeps native slug objects and empty/false/zero values without coercion", () => {
    const input = { ...native(), title: "ok", slug: { _type: "slug", current: "original.Path" }, locale: "", enabled: false, count: 0 };
    expect(validateDocument(input, registry).value).toEqual(input);
    expect(validateDocument({ ...input, slug: "lossy-slug" }, registry).valid).toBe(false);
  });
});

describe("field and reference validation", () => {
  it.each([
    ["title", ""], ["count", 1.5], ["count", -1], ["enabled", "true"], ["tone", "arbitrary-css"], ["url", "javascript:alert(1)"],
    ["date", "2026-02-30"], ["time", "yesterday"], ["items", [{ _type: "wrong", _key: "a", label: "ok" }]],
    ["items", [{ _type: "item", label: "ok" }]]
  ])("rejects invalid %s value", (field, value) => {
    const output = validateDocument({ ...native(), title: "ok", [field]: value }, registry);
    expect(output.valid).toBe(false);
    expect(output.canPublish).toBe(false);
  });
  it("checks sibling keys and nested required paths", () => {
    const output = validateDocument({ ...native(), title: "ok", items: [{ _type: "item", _key: "a" }, { _type: "item", _key: "a", label: "ok" }] }, registry);
    expect(output.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "required", path: '$["items"][0]["label"]' }),
      expect.objectContaining({ code: "duplicate_key", path: '$["items"][1]["_key"]' })
    ]));
  });
  it("requires exact reference matches and retains strong/weak semantics and keys", () => {
    const input = { ...native(), title: "ok", ref: { _type: "reference", _ref: "drafts.target", _weak: false, _key: "r1" } };
    const missing = validateDocument(input, registry, { records: new Map([["target", { _type: "fixture" }]]) });
    expect(missing.canPublish).toBe(false);
    expect(missing.source).toEqual(input);
    expect(missing.findings[0]).toMatchObject({ code: "missing_reference", path: '$["ref"]["_ref"]' });
    expect(validateDocument(input, registry).canPublish).toBe(false);
    const resolved = validateDocument(input, registry, { records: new Map([["drafts.target", { _type: "fixture" }]]) });
    expect(resolved.canPublish).toBe(true);
    expect(resolved.value).toEqual(input);
    const weak = validateDocument({ ...input, ref: { ...input.ref, _weak: true } }, registry, { records: new Map() });
    expect(weak.canPublish).toBe(true);
    expect(weak.findings[0]).toMatchObject({ code: "missing_reference", blocksPublish: false });
  });
  it("rejects empty targets, invalid weak flags and wrong document/asset target types", () => {
    for (const ref of [{ _type: "reference", _ref: "" }, { _type: "reference", _ref: "target", _weak: "false" }]) expect(validateDocument({ ...native(), title: "ok", ref }, registry).valid).toBe(false);
    expect(validateDocument({ ...native(), title: "ok", ref: { _type: "reference", _ref: "target" } }, registry, { records: new Map([["target", { _type: "notFixture" }]]) }).valid).toBe(false);
    expect(validateDocument({ ...native(), title: "ok", asset: { _type: "reference", _ref: "target" } }, registry, { records: new Map([["target", { _type: "fixture" }]]) }).valid).toBe(false);
  });
  it("accepts cycles/forward references from the caller's exact identity map without graph recursion", () => {
    const records = new Map([["one", { _type: "fixture" }], ["two", { _type: "fixture" }]]);
    for (const [id, target] of [["one", "two"], ["two", "one"]]) expect(validateDocument({ ...native("fixture", id), title: "x", ref: { _type: "reference", _ref: target } }, registry, { records }).canPublish).toBe(true);
  });
});

describe("security and explicit resource budgets", () => {
  it.each(["javascript:alert(1)", "data:text/html,test", "vbscript:test", "//evil.test", "/\\evil.test", "https://user:pass@example.test", "https://example.test/%0afoo", " https://example.test", "https://example.test/<script>"])("rejects unsafe URL %s", (url) => expect(isSafeUrl(url)).toBe(false));
  it.each(["https://example.test/a?b=1#c", "http://example.test", "/work/test", "#section"])("accepts reviewed navigation URL %s", (url) => expect(isSafeUrl(url)).toBe(true));
  it("never executes getters, functions or toJSON and rejects prototypes/cycles/prototype pollution", () => {
    let calls = 0;
    const getter = Object.defineProperty({}, "field", { enumerable: true, get() { calls++; throw new Error("no"); } });
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    for (const input of [getter, { toJSON() { calls++; return {}; } }, cyclic, new Date(), { n: Infinity }, JSON.parse('{"__proto__":{"polluted":true}}'), { callback: () => { calls++; } }]) {
      expect(validateDocument(input, registry).valid).toBe(false);
    }
    expect(calls).toBe(0);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
  it("rejects over-depth, over-width, sparse, long-string and oversized node inputs without throwing", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < LIMITS.depth + 2; i++) deep = { nested: deep };
    const wide = Object.fromEntries(Array.from({ length: LIMITS.properties + 1 }, (_, i) => [`k${i}`, i]));
    for (const input of [deep, wide, new Array(2), { a: new Array(LIMITS.array + 1).fill(0) }, { text: "x".repeat(LIMITS.string + 1) }, Array.from({ length: 100 }, () => Array.from({ length: 250 }, () => 0))]) {
      expect(() => validateDocument(input, registry)).not.toThrow();
      expect(validateDocument(input, registry).canPublish).toBe(false);
    }
  });
  it("caps diagnostics and rejects raw HTML even inside unknown content", () => {
    const output = validateDocument({ ...native(), title: "ok", items: [{ _type: "html", _key: "x", html: "<script>bad</script>" }] }, registry);
    expect(output.valid).toBe(false);
    expect(output.source).toBeUndefined();
    const issues = inspectJson(Array.from({ length: 300 }, () => undefined));
    expect(issues.length).toBeLessThanOrEqual(LIMITS.findings + 1);
    expect(issues.at(-1)?.code).toBe("finding_limit");
  });
});

describe("dedicated domain contracts", () => {
  it("registers only the five requested code-owned types and finite landing block tokens", () => {
    expect(cmsSchemas.map((s) => s.name)).toEqual([agencyWork.name, partnerStories.name, productLanding.name, signalCaseStudy.name, languageDictionary.name, article.name]);
    expect(workCaseStudy).toBe(agencyWork);
    expect(testimonial).toBe(partnerStories);
    expect(agencyWork.title).toBe("Work case studies");
    expect(partnerStories.title).toBe("Testimonials & partner stories");
    expect(landingSections.map((s) => s.objectType)).toEqual(LANDING_BLOCK_TOKENS);
  });
  it("validates approved agency work without requiring invented slug/locale", () => {
    const output = validateDocument(work(), cmsSchemaRegistry, { records: refs, mode: "publish" });
    expect(output.findings).toEqual([]);
    expect(output.canPublish).toBe(true);
    expect(validateDocument({ ...work(), detailSummary: "One. Two. Three. Four." }, cmsSchemaRegistry, { records: refs }).valid).toBe(false);
    expect(validateDocument({ ...work(), publicationApproval: { ...approval, status: "pending" } }, cmsSchemaRegistry, { records: refs }).canPublish).toBe(false);
  });
  it("requires real consent rather than source provenance and supports text-logo fallback", () => {
    const input = { ...native("partnerStories", "story:one"), company: "Example", personName: "Example Person", role: "Owner", quote: "Exact generated quote.", tone: "neutral", textBadge: "Example", portrait: { _type: "mediaImage", asset: { _type: "reference", _ref: "image:one" }, alt: "Generated portrait" }, provenance, consent: { ...approval, quote: true, likeness: true } };
    expect(validateDocument(input, cmsSchemaRegistry, { records: refs }).canPublish).toBe(true);
    expect(validateDocument({ ...input, consent: { ...input.consent, likeness: false } }, cmsSchemaRegistry, { records: refs }).canPublish).toBe(false);
    expect(validateDocument({ ...input, logo: { _type: "reference", _ref: "image:one" } }, cmsSchemaRegistry, { records: refs }).canPublish).toBe(false);
    expect(validateDocument({ ...input, consent: undefined }, cmsSchemaRegistry).canPublish).toBe(false);
  });
  it("allows catalog offer references but quarantines editable prices, styles and unknown sections", () => {
    const input = { ...native("productLanding", "landing:one"), product: "jongo", sections: [{ _type: "pricingRef", _key: "p", version: 1, offerId: "core-sla" }], provenance, publicationApproval: approval };
    expect(validateDocument(input, cmsSchemaRegistry).canPublish).toBe(true);
    for (const sections of [[{ ...input.sections[0], price: 149 }], [{ ...input.sections[0], className: "arbitrary-css" }], [{ _type: "customHtml", _key: "x", version: 1, content: "unknown" }]]) {
      const output = validateDocument({ ...input, sections }, cmsSchemaRegistry);
      expect(output.canPublish).toBe(false);
      expect(output.source).toEqual({ ...input, sections });
      expect(output.findings.some((f) => f.disposition === "quarantine")).toBe(true);
    }
  });
  it("blocks illustrative Signal results even when other approval metadata is present", () => {
    const input = { ...native("signalCaseStudy", "signal:one"), title: "Example", summary: "A study", scenario: "Generated", methodology: "Reviewed evidence", services: ["Audit"], disclosure: "verified", customerApproval: approval, provenance, findings: [{ _type: "finding", _key: "f", statement: "Observed finding", source: "Generated source", evidenceWindow: "2026-01", classification: "verified" }] };
    expect(validateDocument(input, cmsSchemaRegistry).canPublish).toBe(true);
    expect(validateDocument({ ...input, disclosure: "illustrative" }, cmsSchemaRegistry).canPublish).toBe(false);
    expect(validateDocument({ ...input, findings: [{ ...input.findings[0], classification: "illustrative" }] }, cmsSchemaRegistry).canPublish).toBe(false);
  });
  it("retains dictionary empty strings and checks keys, duplicates, placeholders and markup", () => {
    const emptyContract = { dictionaryContracts: new Map([["actions.save", []]]) };
    const titleContract = { dictionaryContracts: new Map([["actions.save", ["title"]]]) };
    expect(validateDocument(dictionary(), cmsSchemaRegistry, emptyContract).canPublish).toBe(true);
    expect(validateDocument(dictionary(), cmsSchemaRegistry).canPublish).toBe(false);
    const good = { ...dictionary().entries[0], value: "Save {title}?", placeholders: ["title"] };
    expect(validateDocument({ ...dictionary(), entries: [good] }, cmsSchemaRegistry, titleContract).canPublish).toBe(true);
    expect(validateDocument({ ...dictionary(), entries: [good] }, cmsSchemaRegistry, emptyContract).findings.some((f) => f.code === "immutable_placeholder_contract")).toBe(true);
    for (const entry of [{ ...good, placeholders: [] }, { ...good, key: "bad key" }, { ...good, value: "<b>Hi</b>" }, { ...good, value: "{broken" }]) expect(validateDocument({ ...dictionary(), entries: [entry] }, cmsSchemaRegistry).valid).toBe(false);
    expect(validateDocument({ ...dictionary(), entries: [good, { ...good, _key: "e2" }] }, cmsSchemaRegistry).valid).toBe(false);
    const icu = validateDocument({ ...dictionary(), entries: [{ ...good, format: "icu" }] }, cmsSchemaRegistry);
    expect(icu.canPublish).toBe(false);
    expect(icu.findings.some((f) => f.code === "icu_adapter_required")).toBe(true);
  });
});