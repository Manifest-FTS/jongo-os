import type { Descriptor, FieldDefinition, SchemaRegistry } from "../schema";

type Doc = Record<string, unknown>;
const ENVELOPE = new Set(["_id", "_type", "_rev", "_createdAt", "_updatedAt"]);
const NESTED_SYSTEM = new Set(["_type", "_key"]);

function isObject(value: unknown): value is Doc {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchMember(item: unknown, members: readonly Descriptor[]): Descriptor | undefined {
  if (typeof item === "string") return members.find((m) => ["string", "text", "url", "date", "datetime", "enum"].includes(m.type));
  if (typeof item === "number") return members.find((m) => m.type === "number");
  if (typeof item === "boolean") return members.find((m) => m.type === "boolean");
  if (!isObject(item)) return undefined;
  if (typeof item._type === "string") {
    const type = item._type;
    return members.find((m) => (m.type === "object" && m.objectType === type) ||
      ((m.type === "reference" || m.type === "asset") && type === "reference") ||
      (m.type === "slug" && type === "slug"));
  }
  const untyped = members.filter((m) => m.type === "object" && m.objectType === undefined);
  return untyped.length === 1 ? untyped[0] : undefined;
}

function pick(value: Doc, keys: readonly string[]): Doc {
  const out: Doc = {};
  for (const key of keys) if (Object.hasOwn(value, key)) out[key] = value[key];
  return out;
}

function strip(value: unknown, descriptor: Descriptor): unknown {
  switch (descriptor.type) {
    case "object": return isObject(value) ? stripObject(value, descriptor.fields, false) : undefined;
    case "array": return Array.isArray(value) ? value.flatMap((item) => {
      const member = matchMember(item, descriptor.of);
      if (!member) return [];
      const kept = strip(item, member);
      return kept === undefined ? [] : [kept];
    }) : undefined;
    case "reference": case "asset": return isObject(value) ? pick(value, ["_type", "_ref", "_weak", "_key"]) : undefined;
    case "slug": return isObject(value) ? pick(value, ["_type", "current"]) : undefined;
    case "portableText": return Array.isArray(value) ? value : undefined;
    case "number": return typeof value === "number" ? value : undefined;
    case "boolean": return typeof value === "boolean" ? value : undefined;
    default: return typeof value === "string" ? value : undefined;
  }
}

function stripObject(value: Doc, fields: readonly FieldDefinition[], top: boolean): Doc {
  const out: Doc = {};
  for (const key of Object.keys(value)) {
    if (key.startsWith("_")) {
      if (top ? ENVELOPE.has(key) : NESTED_SYSTEM.has(key)) out[key] = value[key];
      continue;
    }
    const field = fields.find((f) => f.name === key);
    // Allowlist: undeclared fields cannot be classified, so they are not public.
    if (!field || field.private) continue;
    const kept = strip(value[key], field);
    if (kept !== undefined) out[key] = kept;
  }
  return out;
}

/** Public view of a document, or null when its type is not registered (privacy cannot be decided). */
export function toPublicDocument(doc: Doc, registry: SchemaRegistry): Doc | null {
  const definition = typeof doc._type === "string" ? registry.get(doc._type) : undefined;
  return definition ? stripObject(doc, definition.fields, true) : null;
}
