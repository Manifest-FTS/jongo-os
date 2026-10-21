import { describe, expect, it } from "vitest";
import { PORTABLE_TEXT_TOKENS, validatePortableText } from "./portable-text";

const textBlock = () => ({ _type: "block", _key: "block-1", style: "blockquote2", listItem: "bullet", level: 2, markDefs: [
  { _type: "link", _key: "annotation-1", href: "https://example.test/source" },
  { _type: "textColor", _key: "annotation-2", color: "blue" },
  { _type: "buttonStyle1", _key: "button", href: "/contact" }
], children: [
  { _type: "span", _key: "span-1", text: "Exact <text> & punctuation.", marks: ["strong", "superscript", "center", "annotation-1", "annotation-2"] },
  { _type: "span", _key: "span-2", text: "", marks: [] }
] });
describe("native Portable Text AST", () => {
  it("round-trips ordered keys/marks/annotation identities/lists/nested blocks/inline references/image geometry", () => {
    const input = [textBlock(), {
      _type: "group", _key: "group", children: [{ ...textBlock(), _key: "nested", style: "standout" }, {
        _type: "image", _key: "image", asset: { _type: "reference", _ref: "image:one", _weak: false, _key: "asset" }, alt: "", caption: "Exact caption",
        crop: { _type: "sanity.imageCrop", top: 0, bottom: 0.1, left: 0, right: 0 },
        hotspot: { _type: "sanity.imageHotspot", x: 0.5, y: 0.5, width: 1, height: 1 }
      }]
    }, { ...textBlock(), _key: "inline", style: "centered", children: [{ _type: "reference", _key: "ref", _ref: "drafts.document:one", _weak: false }] }];
    const before = JSON.stringify(input);
    const output = validatePortableText(input, { records: new Map([["image:one", { _type: "sanity.imageAsset" }], ["drafts.document:one", { _type: "fixture" }]]) });
    expect(output.findings).toEqual([]);
    expect(output.canPublish).toBe(true);
    expect(output.value).toBe(input);
    expect(JSON.stringify(output.source)).toBe(before);
  });
  it("accepts every finite style/decorator token and empty AST without flattening text", () => {
    for (const style of PORTABLE_TEXT_TOKENS.styles) expect(validatePortableText([{ ...textBlock(), style }]).canPublish).toBe(true);
    expect(validatePortableText([{ ...textBlock(), children: [{ _type: "span", _key: "s", text: "", marks: [...PORTABLE_TEXT_TOKENS.decorators] }] }]).canPublish).toBe(true);
    expect(validatePortableText([]).value).toEqual([]);
  });
  it("quarantines unsupported nested blocks/styles/annotations/fields without losing original JSON", () => {
    for (const input of [
      [{ _type: "info_block", _key: "x", content: [{ _type: "then_now_gallery", _key: "y", rows: [{ cells: [""] }] }] }],
      [{ ...textBlock(), style: "arbitraryCSS" }],
      [{ ...textBlock(), markDefs: [{ _type: "unknown", _key: "a", original: "kept" }] }],
      [{ ...textBlock(), originalExtra: { empty: "", keep: [false, 0] } }]
    ]) {
      const output = validatePortableText(input);
      expect(output.valid).toBe(true);
      expect(output.canPublish).toBe(false);
      expect(output.value).toBeUndefined();
      expect(output.source).toEqual(input);
      expect(output.findings.some((f) => f.disposition === "quarantine" && f.path.startsWith("$[0]"))).toBe(true);
    }
  });
  it("reports dangling mark IDs and duplicate keys instead of regenerating them", () => {
    const input = [{ ...textBlock(), children: [{ _type: "span", _key: "same", text: "one", marks: ["missing-definition"] }, { _type: "span", _key: "same", text: "two", marks: [] }] }];
    const output = validatePortableText(input);
    expect(output.valid).toBe(false);
    expect(output.source).toEqual(input);
    expect(output.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "duplicate_key", path: '$[0]["children"][1]["_key"]' }),
      expect.objectContaining({ code: "unknown_mark", path: '$[0]["children"][0]["marks"][0]' })
    ]));
  });
  it.each(["javascript:alert(1)", "data:text/html,<script>bad</script>", "//evil.test", "/\\evil.test", "https://user:pass@example.test"])("rejects unsafe annotation URL %s", (href) => {
    const output = validatePortableText([{ ...textBlock(), markDefs: [{ _type: "link", _key: "annotation-1", href }] }]);
    expect(output.canPublish).toBe(false);
    expect(output.findings.some((f) => f.code === "unsafe_url")).toBe(true);
  });
  it.each(["html", "rawHtml", "script", "iframe"])("rejects executable %s nodes, including unknown subtrees", (_type) => {
    const output = validatePortableText([{ _type: "unknown", _key: "x", children: [{ _type, _key: "y", content: "<script>bad</script>" }] }]);
    expect(output.valid).toBe(false);
    expect(output.source).toBeUndefined();
  });
  it("rejects freeform color CSS, invalid geometry, malformed blocks and annotation collisions", () => {
    for (const input of [
      [{ ...textBlock(), markDefs: [{ _type: "textColor", _key: "annotation-2", color: "url(javascript:bad)" }] }],
      [{ _type: "image", _key: "i", asset: { _type: "reference", _ref: "i" }, crop: { top: 0.5, bottom: 0.5, left: 0, right: 0 } }],
      [{ ...textBlock(), level: 0 }], [{ ...textBlock(), children: "flattened" }],
      [{ ...textBlock(), markDefs: [{ _type: "link", _key: "strong", href: "/ok" }] }],
      [{ ...textBlock(), children: [{ ...textBlock(), _key: "invalid-inline" }] }],
      [{ _type: "block", children: [], markDefs: [] }], [null], {}, undefined
    ]) {
      expect(() => validatePortableText(input)).not.toThrow();
      expect(validatePortableText(input).valid).toBe(false);
    }
  });
  it("handles unchecked strong and weak inline references explicitly without inventing targets", () => {
    const reference = { _type: "reference", _key: "r", _ref: "drafts.missing" };
    const output = validatePortableText([reference], { records: new Map([["missing", { _type: "fixture" }]]) });
    expect(output.canPublish).toBe(false);
    expect(output.source).toEqual([reference]);
    expect(output.findings[0]).toMatchObject({ code: "missing_reference", path: '$[0]["_ref"]' });
    expect(validatePortableText([{ ...reference, _weak: true }]).findings[0]).toMatchObject({ blocksPublish: false });
  });
});