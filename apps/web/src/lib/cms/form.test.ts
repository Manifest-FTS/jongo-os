import { describe, expect, it } from "vitest";
import { cmsFormValues, parseCmsFields } from "./form";
import { createSchemaRegistry, defineType, validateDocument } from "./schema";

const schema = defineType({ name: "roundtrip", type: "document", schemaVersion: 1, fields: [
  { name: "title", type: "string" }, { name: "body", type: "text" },
  { name: "absent", type: "string" }, { name: "enabled", type: "boolean" },
  { name: "ref", type: "reference", to: ["roundtrip"] },
  { name: "asset", type: "asset", to: ["sanity.imageAsset"] },
  { name: "nested", type: "object", fields: [{ name: "ref", type: "reference", to: ["roundtrip"] }] }
] });
const envelope = { _id: "drafts.roundtrip", _type: "roundtrip", _rev: "source",
  _createdAt: "2026-10-20T00:00:00Z", _updatedAt: "2026-10-20T00:00:00Z" };

describe("CMS form value preservation", () => {
  it.each([true, false])("round trips complete top-level and nested references with _weak=%s", (weak) => {
    const ref = { _type: "reference", _ref: "drafts.target", _weak: weak, _key: "stable" };
    const document = { title: "", body: "", enabled: false, ref, asset: { ...ref, _ref: "image-id" }, nested: { ref } };
    const parsed = parseCmsFields(schema, cmsFormValues(schema, document));
    expect(parsed).toEqual({ fields: document, errors: [] });
    expect(Object.hasOwn(parsed.fields, "absent")).toBe(false);
    expect(parseCmsFields(schema, cmsFormValues(schema, parsed.fields))).toEqual(parsed);
  });
  it("edits only _ref without discarding metadata, or explicitly unsets a field", () => {
    const values = cmsFormValues(schema, { ref: { _type: "reference", _ref: "old", _weak: false, _key: "key" }, title: "" });
    values.ref = JSON.stringify({ ...JSON.parse(String(values.ref)), _ref: "new" });
    delete values.title;
    expect(parseCmsFields(schema, values).fields).toEqual({ ref: { _type: "reference", _ref: "new", _weak: false, _key: "key" } });
    expect(parseCmsFields(schema, { title: "" }).fields).toEqual({ title: "" });
  });
  it.each(["plain-id", '"json-string"', '{"_type":"reference","_ref":"id","_weak":"false"}', '{"_type":"reference","_ref":"id","_key":""}', '{"constructor":1}'])("rejects unsafe or invalid reference editor input %s", (ref) => {
    const parsed = parseCmsFields(schema, { ref });
    const checked = validateDocument({ ...envelope, ...parsed.fields }, createSchemaRegistry([schema]), { mode: "draft" });
    expect(parsed.errors.length > 0 || !checked.valid || checked.findings.some(f => f.disposition === "quarantine")).toBe(true);
  });
});