import { describe, expect, it, vi } from "vitest";
import { mapApprovedRelease, MarketingProjectionError, toPublicArticleListItem, type ApprovedReleaseEnvelope, type PublicArticleDetail } from "./marketing-contracts";
import { marketingDtoJsonSchema } from "./marketing-contracts.schema";
import { loadApprovedMarketingRelease } from "./marketing-release-adapter";
import { validateDocument } from "./schema";
import { article, cmsSchemaRegistry } from "./schemas";

// Synthetic internal release fixtures exercise projection, NOT access authorization.
const approval = { status: "approved", evidence: "PRIVATE_EVIDENCE", reviewer: "PRIVATE_REVIEWER", approvedAt: "2026-10-01T00:00:00Z" };
const provenance = { source: "PRIVATE_SOURCE_PATH", attribution: "PRIVATE_ATTRIBUTION", sourceUrl: "https://private.example.test" };
const native = (type: string) => ({ _id: `${type}:one`, _type: type, _rev: "PRIVATE_SOURCE_REV", _createdAt: "2026-01-01T00:00:00Z", _updatedAt: "2026-10-01T00:00:00Z" });
const slug = { _type: "slug" as const, current: "example" };
const asset = { _type: "reference" as const, _ref: "image:one" };
const media = { _type: "mediaImage", _key: "media1", asset, alt: "Approved image description", caption: "Approved caption" };
const references = new Map([["image:one", { _type: "sanity.imageAsset", url: "https://private.example.test/original", bucketKey: "PRIVATE_BUCKET" }]]);
const rendition = () => ({ url: "https://cdn.example.test/approved/image.webp", alt: "Approved card description", caption: "Approved card caption", storageKey: "PRIVATE_STORAGE" });
const work = () => ({ ...native("agencyWork"), slug, clientName: "Example", category: "Web", tone: "sage", services: ["Development"],
  headline: "Example headline", detailSummary: "A documented project.", cardAsset: asset, gallery: [media],
  technicalSpecs: ["Documented specification"], projectUrl: "https://example.test", caseStudyUrl: "/work/example",
  attribution: "Approved implementation credit", author: { name: "Sourced author", role: "Writer", url: "https://example.test/about" },
  provenance, publicationApproval: approval });
const story = () => ({ ...native("partnerStories"), slug, company: "Example company", personName: "Sourced person", role: "Partner",
  quote: "Exact sourced quote with more words.", excerpt: "Exact sourced quote …", omissionMarker: "…", tone: "charcoal", textBadge: "Example company",
  portrait: { _type: media._type, asset, alt: media.alt, focalPoint: { x: 0, y: 1 } },
  badge: { kind: "history", label: "Partnership began in 2018", source: "PRIVATE_BADGE_SOURCE", period: "2018" },
  partnershipBeganAt: "2018-01-01", link: { href: "/work/example", label: "Read the story" },
  consent: { ...approval, quote: true, likeness: true }, provenance });
const block = () => ({ _type: "block", _key: "b1", style: "normal", markDefs: [{ _type: "link", _key: "a1", href: "/work/example" }],
  children: [{ _type: "span", _key: "s1", text: "Sourced article text", marks: ["strong", "a1"] }] });
const articleDocument = () => ({ ...native("article"), slug, title: "Sourced title", excerpt: "Sourced excerpt", body: [block()],
  cover: { _type: media._type, asset, alt: media.alt, caption: media.caption }, publishedAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z", seo: { title: "Sourced SEO title", description: "Sourced description" },
  provenance, publicationApproval: approval });
function trustedFixture(payload: unknown): ApprovedReleaseEnvelope {
  return { release: { releaseId: "internal-release-1", datasetId: "dataset-1", documentId: "document-1", revisionId: "revision-1", schemaVersion: 1 },
    revision: { id: "revision-1", datasetId: "dataset-1", documentId: "document-1", schemaVersion: 1, payload }, references };
}
const project = (payload: unknown) => mapApprovedRelease(trustedFixture(payload), rendition);

// Small independent shape checker for the JSON Schema keywords used here. Not a
// production validator/authorization boundary; no dependency or network needed.
function matches(value: unknown, schema: Record<string, any>): boolean {
  if (schema.$ref) return matches(value, (marketingDtoJsonSchema.$defs as Record<string, any>)[schema.$ref.split("/").at(-1)]);
  if (schema.oneOf) return schema.oneOf.filter((s: any) => matches(value, s)).length === 1;
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === "string" && (typeof value !== "string" || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) return false;
  if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value)) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) return false;
  }
  if (schema.type === "array") return Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.every(item => matches(item, schema.items));
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    if (schema.required.some((key: string) => !Object.hasOwn(object, key))) return false;
    return Object.entries(object).every(([key, item]) => Object.hasOwn(schema.properties, key) && matches(item, schema.properties[key]));
  }
  return true;
}

describe("article authoring schema", () => {
  it("registers articles with private provenance/approval and optional sourced authors, not an invented author default", () => {
    const input = articleDocument();
    expect(validateDocument(input, cmsSchemaRegistry, { records: references, mode: "publish" })).toMatchObject({ valid: true, canPublish: true });
    expect(article.rules).toEqual(["publicationApproval"]);
    for (const name of ["provenance", "publicationApproval"]) expect(article.fields.find(field => field.name === name)).toMatchObject({ private: true, publishRequired: true });
    expect(project(input)).not.toHaveProperty("author");
    expect(project({ ...input, author: { name: "Approved writer" }, attribution: "Approved credit" })).toMatchObject({ author: { name: "Approved writer" }, attribution: "Approved credit" });
  });
  it.each(["title", "excerpt", "body", "slug"])("requires %s", name => {
    const input: Record<string, unknown> = articleDocument(); delete input[name];
    expect(validateDocument(input, cmsSchemaRegistry).valid).toBe(false);
  });
  it("allows incomplete private drafts but denies projection until publication approval, dates and cover are supplied", () => {
    const draft: Record<string, unknown> = { ...articleDocument(), _id: "drafts.article:one" };
    for (const key of ["publicationApproval", "publishedAt", "cover", "provenance"]) delete draft[key];
    expect(validateDocument(draft, cmsSchemaRegistry)).toMatchObject({ valid: true, canPublish: false });
    expect(() => project(draft)).toThrow(MarketingProjectionError);
    for (const name of ["publicationApproval", "publishedAt", "cover", "provenance"]) {
      const input: Record<string, unknown> = articleDocument(); delete input[name];
      expect(() => project(input)).toThrow(MarketingProjectionError);
    }
  });
});

describe("pure public projection contract (trusted internal fixtures, not auth tests)", () => {
  it("maps work field names and image URLs, retaining all gallery images and approved credits only", () => {
    const input = { ...work(), gallery: [media, { ...media, _key: "media2", alt: "Second description" }] };
    const before = JSON.stringify(input);
    const output = project(input);
    expect(output).toMatchObject({ kind: "workCaseStudy", id: "agencyWork:one", slug: "example", name: "Example", summary: input.detailSummary,
      gallery: [{ src: rendition().url, alt: media.alt, caption: media.caption }, { src: rendition().url, alt: "Second description", caption: media.caption }],
      technicalSpecs: input.technicalSpecs, author: input.author, attribution: input.attribution });
    expect(JSON.stringify(input)).toBe(before);
    expect(output).not.toHaveProperty("clientName");
    expect(output).not.toHaveProperty("sourceUrl");
  });
  it("maps exact testimonial excerpts, portrait and site badges without badge sources/consent", () => {
    const output = project(story());
    expect(output).toMatchObject({ kind: "testimonial", name: "Sourced person", quote: "Exact sourced quote …", portrait: rendition().url,
      portraitAlt: media.alt, portraitFocalPoint: { x: 0, y: 1 }, companyBadge: { kind: "text", label: "Example company" },
      badge: { kind: "history", label: "Partnership began in 2018", period: "2018" }, link: { href: "/work/example", label: "Read the story" } });
    expect(output).not.toHaveProperty("author");
    expect(() => project({ ...story(), consent: { ...approval, quote: true, likeness: false } })).toThrow(MarketingProjectionError);
    expect(() => project({ ...story(), logo: asset, logoVerified: false })).toThrow(MarketingProjectionError);
    expect(() => project({ ...story(), omissionMarker: undefined })).toThrow(MarketingProjectionError);
  });
  it("never leaks private fields through DTO JSON, including nested records and resolver metadata", () => {
    for (const input of [work(), story(), articleDocument()]) {
      const encoded = JSON.stringify(project(input));
      for (const token of ["PRIVATE", "private.example", "provenance", "publicationApproval", "consent", "sourcePath", "sourceUrl", "_ref", "_rev", "evidence", "reviewer", "approvedAt", "bucketKey", "storageKey"]) expect(encoded).not.toContain(token);
    }
  });
  it.each([work(), story(), articleDocument()])("matches the public JSON Schema and rejects additional private properties", input => {
    const dto = project(input);
    expect(matches(dto, marketingDtoJsonSchema)).toBe(true);
    expect(matches({ ...dto, provenance }, marketingDtoJsonSchema)).toBe(false);
  });
  it("maps only the safe article AST and explicitly strips body/SEO from list DTOs", () => {
    const input = articleDocument();
    const detail = project({ ...input, body: [block(), { _type: "image", _key: "img1", asset, alt: media.alt, caption: media.caption }] }) as PublicArticleDetail;
    expect(detail.body[0]).toEqual(block());
    expect(detail.body[1]).toEqual({ _type: "image", _key: "img1", src: rendition().url, alt: media.alt, caption: media.caption });
    expect(matches(detail, marketingDtoJsonSchema)).toBe(true);
    const list = toPublicArticleListItem(detail);
    expect(list).not.toHaveProperty("body"); expect(list).not.toHaveProperty("seo");
    expect(matches(list, marketingDtoJsonSchema.$defs.ArticleListItem)).toBe(true);
    expect(list.cover).not.toBe(detail.cover);
  });
  it.each([
    [{ ...block(), style: "centered" }],
    [{ ...block(), children: [{ _type: "span", _key: "s1", text: "Text", marks: ["underline"] }] }],
    [{ _type: "group", _key: "g1", children: [block()] }],
    [{ _type: "reference", _key: "r1", _ref: "image:one" }],
    [{ _type: "html", _key: "h1", html: "<p>not supported</p>" }],
    [{ ...block(), markDefs: [{ _type: "link", _key: "a1", href: "javascript:alert(1)" }] }],
    [{ ...block(), markDefs: [{ _type: "buttonStyle1", _key: "a1", href: "/work/example" }] }],
    [{ _type: "image", _key: "i1", asset }], []
  ].map(body => ({ body })))("fails closed on unsupported/unsafe article rendering: %j", ({ body }) => {
    expect(() => project({ ...articleDocument(), body })).toThrow(MarketingProjectionError);
  });
  it("does not treat HTML-looking span text as HTML", () => {
    const output = project({ ...articleDocument(), body: [{ ...block(), children: [{ _type: "span", _key: "s1", text: "<b>literal escaped text</b>", marks: [] }] }] }) as PublicArticleDetail;
    expect(output.body[0]).toMatchObject({ children: [{ text: "<b>literal escaped text</b>" }] });
  });
});

describe("release/asset boundary remains explicit and unavailable", () => {
  it.each([null, true, { trusted: true }, { canPublish: true }, { variant: "published" }])("rejects substitute release claims %j", release => {
    expect(() => mapApprovedRelease({ ...trustedFixture(work()), release } as unknown as ApprovedReleaseEnvelope, rendition)).toThrow(MarketingProjectionError);
  });
  it.each(["id", "datasetId", "documentId", "schemaVersion"])("rejects mismatched selected revision %s", key => {
    const envelope = trustedFixture(work());
    expect(() => mapApprovedRelease({ ...envelope, revision: { ...envelope.revision, [key]: key === "schemaVersion" ? 2 : "different" } }, rendition)).toThrow(MarketingProjectionError);
  });
  it("rejects source-published but unapproved, source drafts, unknown fields/types/schema and missing exact references", () => {
    for (const input of [{ ...work(), publicationApproval: { ...approval, status: "pending" } }, { ...work(), _id: "drafts.agencyWork:one" },
      { ...work(), unreviewed: true }, { ...work(), _type: "workCaseStudy" }, { ...work(), slug: { ...slug, current: "bad/path" } }]) expect(() => project(input)).toThrow(MarketingProjectionError);
    const envelope = trustedFixture(work());
    expect(() => mapApprovedRelease({ ...envelope, references: new Map() }, rendition)).toThrow(MarketingProjectionError);
    expect(() => mapApprovedRelease({ ...envelope, release: { ...envelope.release, schemaVersion: 2 }, revision: { ...envelope.revision, schemaVersion: 2 } }, rendition)).toThrow(MarketingProjectionError);
  });
  it.each([null, { ...rendition(), url: "javascript:alert(1)" }, { ...rendition(), url: "//evil.test/a" },
    { ...rendition(), url: "http://example.test/image" }, { ...rendition(), url: "https://user:secret@example.test/a" }, { ...rendition(), alt: " " }])("rejects unavailable/unapproved rendition %j", assetResult => {
    expect(() => mapApprovedRelease(trustedFixture(work()), () => assetResult)).toThrow(MarketingProjectionError);
  });
  it("uses the release-bound callback, never the raw asset URL, and sanitizes resolver failure", () => {
    const resolver = vi.fn(rendition);
    mapApprovedRelease(trustedFixture(work()), resolver);
    expect(resolver).toHaveBeenCalledWith({ _type: "reference", _ref: "image:one" }, trustedFixture(work()).release);
    expect(() => mapApprovedRelease(trustedFixture(work()), () => { throw new Error("PRIVATE_CREDENTIAL"); })).toThrow("Marketing public projection unavailable.");
  });
  it("keeps the real server adapter unavailable instead of pretending fixtures authorize public delivery", async () => {
    await expect(loadApprovedMarketingRelease({ consumerId: "manifest", type: "article", slug: "example", locale: "en" })).rejects.toThrow("not implemented");
  });
});