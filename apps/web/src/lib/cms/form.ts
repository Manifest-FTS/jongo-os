import type { Finding, TypeDefinition } from "./schema";
import { childPath, finding, LIMITS } from "./validation";

export type Values = Record<string, string | boolean>;

/** Controlled defaults never create a field that was absent from the document. */
export function cmsFormValues(schema: TypeDefinition, document: Record<string, unknown>): Values {
  return Object.fromEntries(schema.fields.flatMap((field) => {
    if (!Object.hasOwn(document, field.name)) return [];
    const raw = document[field.name];
    if (raw === undefined || raw === null) return [];
    const value = field.type === "slug" ? (raw as { current: string }).current
      : ["reference", "asset", "object", "array", "portableText"].includes(field.type) ? JSON.stringify(raw, null, 2)
      : typeof raw === "boolean" ? raw : String(raw);
    return [[field.name, value]];
  }));
}

/** Dependency-free conversion, shared with server validation. No envelope input. */
export function parseCmsFields(schema: TypeDefinition, values: Values): { fields: Record<string, unknown>; errors: Finding[] } {
  const fields: Record<string, unknown> = {};
  const errors: Finding[] = [];
  for (const field of schema.fields) {
    const raw = values[field.name];
    if (!Object.hasOwn(values, field.name) || raw === undefined) continue;
    // Empty scalar text is data. Blank non-text controls mean not set.
    if (raw === "" && !["string", "text", "url", "date", "datetime", "enum"].includes(field.type)) continue;
    const path = childPath("$", field.name);
    if (typeof raw === "string" && raw.length > LIMITS.string) {
      errors.push(finding(path, "string_limit", "Editor input exceeds the 100,000 character limit."));
      continue;
    }
    switch (field.type) {
      case "number": fields[field.name] = Number(raw); break;
      case "slug": fields[field.name] = { _type: "slug", current: raw }; break;
      case "reference": case "asset": case "object": case "array": case "portableText":
        try { fields[field.name] = JSON.parse(String(raw)); }
        catch { errors.push(finding(path, "json", "Enter valid JSON.")); }
        break;
      default: fields[field.name] = raw;
    }
  }
  return { fields, errors };
}