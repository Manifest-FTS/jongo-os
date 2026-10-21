import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import CmsFormBuilder, { validateSchemaPreview } from "./CmsFormBuilder";
import { cmsSchemaRegistry } from "@/lib/cms/schemas";
import { defineType } from "@/lib/cms/schema";

const hooks = vi.hoisted(() => ({ active: false, useId: vi.fn(), useState: vi.fn() }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
    useId: () => hooks.active ? hooks.useId() : actual.useId(),
    useState: (initial: unknown) => hooks.active ? hooks.useState(initial) : actual.useState(initial)
  };
});

const schema = defineType({ name: "test", type: "document", schemaVersion: 1, fields: [
  { name: "title", title: "Display title", description: "A useful title", type: "string", required: true, minLength: 1, maxLength: 20 },
  { name: "body", type: "text" }, { name: "count", type: "number", integer: true, min: 1, max: 10 },
  { name: "enabled", type: "boolean", required: true }, { name: "tone", type: "enum", options: ["blue", "lime"] },
  { name: "url", type: "url" }, { name: "slug", type: "slug" },
  { name: "ref", type: "reference", to: ["test"] }, { name: "asset", type: "asset", to: ["sanity.imageAsset"] },
  { name: "object", type: "object", fields: [{ name: "title", type: "string", required: true }] },
  { name: "items", type: "array", keyed: true, maxItems: 2, of: [{ type: "object", fields: [{ name: "name", type: "string", required: true }] }] },
  { name: "rich", type: "portableText" }
] });
const valid = { title: "Test", enabled: false };
const codes = (values: Parameters<typeof validateSchemaPreview>[1]) => validateSchemaPreview(schema, values).map((f) => f.code);
afterEach(() => { hooks.active = false; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("local schema preview validator", () => {
  it("requires missing fields but accepts explicit false without defaulting values", () => {
    expect(codes({})).toEqual(["required", "required"]);
    expect(validateSchemaPreview(schema, valid)).toEqual([]);
  });
  it.each([
    [{ count: "0" }, "number_bounds"], [{ count: "1.5" }, "number_bounds"],
    [{ count: "Infinity" }, "not_json"], [{ tone: "magenta" }, "enum"],
    [{ title: "x".repeat(21) }, "length"], [{ url: "javascript:alert(1)" }, "unsafe_url"],
    [{ object: "{" }, "json"], [{ object: "{}" }, "required"],
    [{ items: '[{"_key":"a","name":"a"},{"_key":"a","name":"b"}]' }, "duplicate_key"],
    [{ items: '[{"name":"a"}]' }, "key"], [{ items: "[1,2,3]" }, "array_bounds"],
    [{ rich: '[{"_type":"html"}]' }, "unsafe_block"], [{ rich: "{}" }, "portable_text"],
    [{ object: '{"constructor":1}' }, "unsafe_key"], [{ object: "x".repeat(100001) }, "string_limit"]
  ])("passes invalid values through schema validation: %j", (values, expected) => {
    expect(codes({ ...valid, ...values })).toContain(expected);
  });
  it("parses explicit reference objects without claiming targets are verified", () => {
    const findings = validateSchemaPreview(schema, { ...valid, slug: "example", ref: '{"_type":"reference","_ref":"exact-source"}', asset: '{"_type":"reference","_ref":"image-id"}' });
    expect(findings.map((f) => f.code)).toEqual(["unchecked_reference", "unchecked_reference"]);
    expect(findings.every((f) => f.disposition === "review")).toBe(true);
    expect(codes({ ...valid, url: "/work/example" })).toEqual([]);
  });
  it("uses registered named rules, including work summary and dictionary checks", () => {
    const work = cmsSchemaRegistry.get("agencyWork")!;
    expect(validateSchemaPreview(work, { detailSummary: "One. Two. Three. Four." }).map((f) => f.code)).toContain("summary_sentences");
    const dictionary = cmsSchemaRegistry.get("languageDictionary")!;
    expect(validateSchemaPreview(dictionary, { audience: "common", locale: "en", version: "1", entries: '[{"_key":"a","_type":"dictionaryEntry","key":"title","value":"Hello","placeholders":[],"format":"plain","status":"approved","revision":"1"}]' }).map((f) => f.code)).toContain("dictionary_contract_unchecked");
  });
});

describe("schema form rendering and local handlers", () => {
  it("submits loaded metadata and empty strings unchanged, edits reference JSON and explicitly unsets text", async () => {
    let slots: unknown[] = [], cursor = 0;
    hooks.active = true; hooks.useId.mockReturnValue("roundtrip");
    hooks.useState.mockImplementation((initial: unknown) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (next: unknown) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
    });
    const ref = { _type: "reference", _ref: "old", _weak: false, _key: "stable" };
    const onSave = vi.fn().mockResolvedValue({ message: "Saved" });
    const props = { schemas: [schema], canAuthor: true, draft: { initialDocument: { title: "", ref }, onSave } };
    const nodes = (node: React.ReactNode): React.ReactElement[] => !React.isValidElement(node) ? []
      : [node, ...React.Children.toArray(node.props.children).flatMap(nodes)];
    const root = CmsFormBuilder(props);
    const child = nodes(root).find(n => typeof n.type === "function")!;
    const Preview = child.type as (props: any) => React.ReactElement;
    slots = [];
    const draw = () => { cursor = 0; return nodes(Preview(child.props)); };
    await draw().find(n => n.type === "form")!.props.onSubmit({ preventDefault: vi.fn() });
    expect(onSave.mock.calls[0][0]).toEqual({ title: "", ref: JSON.stringify(ref, null, 2) });
    expect(draw().find(n => n.props.name === "ref")!.type).toBe("textarea");
    draw().find(n => n.props.name === "ref")!.props.onChange({ target: { value: JSON.stringify({ ...ref, _ref: "new" }) } });
    draw().find(n => n.type === "button" && React.Children.toArray(n.props.children).join("") === "Unset field: Display title")!.props.onClick();
    await draw().find(n => n.type === "form")!.props.onSubmit({ preventDefault: vi.fn() });
    expect(onSave.mock.calls[1][0]).toEqual({ ref: JSON.stringify({ ...ref, _ref: "new" }) });
  });
  it("loads persisted field values and presents draft saving without publication controls", () => {
    const html = renderToStaticMarkup(<CmsFormBuilder schemas={[schema]} canAuthor draft={{
      initialDocument: { title: "Persisted title", enabled: false, count: 3, slug: { _type: "slug", current: "saved-slug" },
        ref: { _type: "reference", _ref: "exact-ref" }, object: { title: "Nested" } },
      onSave: vi.fn()
    }} />);
    expect(html).toContain("Persisted title"); expect(html).toContain("saved-slug");
    expect(html).toContain("exact-ref"); expect(html).toContain("Nested");
    expect(html).toContain("Save draft"); expect(html).not.toContain("Validate locally");
    expect(html).not.toMatch(/>Publish</);
  });
  it("renders metadata, all six types, required labels, native fields and no mutation controls", () => {
    const html = renderToStaticMarkup(<CmsFormBuilder schemas={cmsSchemaRegistry.descriptors} canAuthor />);
    for (const definition of cmsSchemaRegistry.descriptors) {
      const escapedTitle = renderToStaticMarkup(<span>{definition.title}</span>).slice(6, -7);
      expect(html).toContain(escapedTitle);
    }
    expect(html).toContain("Schema preview only. Nothing is saved or published.");
    expect(html).toContain("clientName (required)");
    expect(html).toContain("Registered JSON schema descriptor");
    expect(html).toContain("nested visual builder is future work");
    expect(html).not.toMatch(/type="submit"[^>]*>(Save|Publish)|formAction=|action=/);
    const fields = renderToStaticMarkup(<CmsFormBuilder schemas={[schema]} canAuthor />);
    expect(fields).toContain("Display title (required)");
    expect(fields).toContain("A useful title");
    expect(fields).toContain('type="number"');
    expect(fields).toContain("<textarea");
    expect(fields).toContain('value="false"');
  });
  it("keeps descriptors and schema selection available but disables author controls", () => {
    const html = renderToStaticMarkup(<CmsFormBuilder schemas={[schema]} canAuthor={false} />);
    expect(html).toMatch(/<fieldset disabled=""/);
    expect(html).toContain("Read-only schema preview");
    expect(html).toContain("Registered JSON schema descriptor");
  });
  it("isolates keyed schema state and clears stale validation on edits without network or storage", () => {
    // Dependency-free hook harness: exercise the actual handlers, not a second form implementation.
    let slots: unknown[] = [], cursor = 0;
    hooks.active = true;
    hooks.useId.mockReturnValue("preview");
    hooks.useState.mockImplementation((initial: unknown) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (next: unknown) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
    });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const storage = { setItem: vi.fn() };
    vi.stubGlobal("localStorage", storage);
    const draw = (fn: () => React.ReactElement) => { cursor = 0; return fn(); };
    const children = (node: React.ReactNode): React.ReactElement[] => {
      if (!React.isValidElement(node)) return [];
      return [node, ...React.Children.toArray(node.props.children).flatMap(children)];
    };
    const root = draw(() => CmsFormBuilder({ schemas: [schema, ...cmsSchemaRegistry.descriptors], canAuthor: true }));
    const first = children(root).find((node) => typeof node.type === "function")!;
    const select = children(root).find((node) => node.type === "select")!;
    select.props.onChange({ target: { value: "agencyWork" } });
    const changed = children(draw(() => CmsFormBuilder({ schemas: [schema, ...cmsSchemaRegistry.descriptors], canAuthor: true }))).find((node) => typeof node.type === "function")!;
    expect(changed.key).not.toBe(first.key); // React remounts local fields/errors, including when switching back.
    const Preview = first.type as (props: typeof first.props) => React.ReactElement;
    slots = [];
    let tree = draw(() => Preview(first.props));
    const submit = () => children(tree).find((node) => node.type === "form")!.props.onSubmit({ preventDefault: vi.fn() });
    submit();
    tree = draw(() => Preview(first.props));
    expect(children(tree).some((node) => node.props["aria-label"] === "Validation summary")).toBe(true);
    expect(children(tree).find((node) => node.type === "input")!.props["aria-invalid"]).toBe(true);
    children(tree).find((node) => node.type === "input")!.props.onChange({ target: { value: "Changed" } });
    tree = draw(() => Preview(first.props));
    expect(children(tree).some((node) => node.props["aria-label"] === "Validation summary")).toBe(false);
    expect(children(tree).find((node) => node.type === "input")!.props.value).toBe("Changed");
    expect(fetch).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    slots = [];
    tree = draw(() => Preview({ ...first.props, canAuthor: false }));
    submit();
    expect(slots[1]).toBeNull();
  });
});