/** Shared, dependency-free validation primitives. Never log or render source data. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type Finding = {
  path: string;
  code: string;
  severity: "error" | "warning";
  disposition: "reject" | "quarantine" | "review";
  blocksPublish: boolean;
  message: string;
};
export type ValidationResult<T> = {
  valid: boolean;
  /** Structural eligibility only; NOT permission, consent verification, or release authorization. */
  canPublish: boolean;
  value?: T;
  /** Restricted/private original JSON, including unknown subtrees; never a public DTO. */
  source?: JsonValue;
  findings: Finding[];
};
export const LIMITS = Object.freeze({ depth: 32, nodes: 20000, array: 2000, properties: 200, string: 100000, findings: 200 });
export function childPath(path: string, key: string | number): string {
  return typeof key === "number" ? `${path}[${key}]` : `${path}[${JSON.stringify(key)}]`;
}
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function finding(path: string, code: string, message: string, quarantine = false, blocksPublish = true): Finding {
  return { path, code, message, severity: quarantine ? "warning" : "error", disposition: quarantine ? "quarantine" : "reject", blocksPublish };
}
export function addFinding(findings: Finding[], item: Finding): void {
  if (findings.length < LIMITS.findings) findings.push(item);
  else if (findings.length === LIMITS.findings) findings.push(finding("$", "finding_limit", "Further findings omitted; validation remains blocked."));
}
/** Inspect property descriptors: getters/toJSON/functions are never executed. No JSON stringify on input. */
export function inspectJson(input: unknown): Finding[] {
  const findings: Finding[] = [];
  const ancestors = new Set<object>();
  let nodes = 0;
  function walk(value: unknown, path: string, depth: number): void {
    if (++nodes > LIMITS.nodes) {
      if (nodes === LIMITS.nodes + 1) addFinding(findings, finding(path, "node_limit", "JSON node budget exceeded."));
      return;
    }
    if (depth > LIMITS.depth) { addFinding(findings, finding(path, "depth_limit", "JSON depth budget exceeded.")); return; }
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "string") {
      if (value.length > LIMITS.string) addFinding(findings, finding(path, "string_limit", "String budget exceeded."));
      return;
    }
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (typeof value !== "object") { addFinding(findings, finding(path, "not_json", "Expected finite JSON data.")); return; }
    if (ancestors.has(value)) { addFinding(findings, finding(path, "cycle", "Cyclic objects are not JSON.")); return; }
    const array = Array.isArray(value);
    const proto = Object.getPrototypeOf(value);
    if (!array && proto !== Object.prototype && proto !== null) { addFinding(findings, finding(path, "prototype", "Only plain JSON objects are supported.")); return; }
    const keys = Reflect.ownKeys(value);
    if ((array && value.length > LIMITS.array) || keys.length > (array ? LIMITS.array + 1 : LIMITS.properties)) {
      addFinding(findings, finding(path, "collection_limit", "JSON collection budget exceeded.")); return;
    }
    ancestors.add(value);
    for (const key of keys) {
      if (array && key === "length") continue;
      const p = typeof key === "string" ? childPath(path, array && /^\d+$/.test(key) ? Number(key) : key) : path;
      if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)) {
        addFinding(findings, finding(p, "unsafe_key", "Unsafe JSON property.")); continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !("value" in descriptor) || (array && !/^(0|[1-9]\d*)$/.test(key))) {
        addFinding(findings, finding(p, "not_json", "Accessors and non-JSON properties are prohibited.")); continue;
      }
      if (["__html", "dangerouslySetInnerHTML"].includes(key) || (key === "_type" && ["html", "rawHtml", "script", "iframe"].includes(descriptor.value))) {
        addFinding(findings, finding(p, "unsafe_block", "Raw HTML/executable content is prohibited."));
      }
      walk(descriptor.value, p, depth + 1);
      if (nodes > LIMITS.nodes) break;
    }
    if (array && Object.keys(value).length !== value.length) addFinding(findings, finding(path, "sparse_array", "Sparse arrays are not JSON arrays."));
    ancestors.delete(value);
  }
  try { walk(input, "$", 0); }
  catch { addFinding(findings, finding("$", "unreadable_json", "Input cannot be inspected safely.")); }
  return findings;
}
export function result<T>(source: JsonValue | undefined, findings: Finding[], value?: T): ValidationResult<T> {
  const valid = !findings.some((item) => item.severity === "error");
  return { valid, canPublish: !findings.some((item) => item.blocksPublish), source, value: valid ? value : undefined, findings };
}
export function unknownFields(value: Record<string, unknown>, allowed: readonly string[], path: string, findings: Finding[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) addFinding(findings, finding(childPath(path, key), "unknown_field", "Unregistered field retained privately; reviewed adapter required.", true));
  }
}
/** Display/navigation safety only, not a remote-fetch/SSRF policy. No decoding or rewriting. */
export function isSafeUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\s\u0000-\u001f\u007f\\<>]/.test(value)) return false;
  if (/%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(value)) return false;
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  if (/^#[a-zA-Z0-9_-]+$/.test(value)) return true;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}
export function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19);
}
export type Reference = { _type: "reference"; _ref: string; _weak?: boolean; _key?: string };
export type ReferenceTarget = { _type: string };
export type ReferenceContext = { records?: ReadonlyMap<string, ReferenceTarget> };
export function validateReference(value: unknown, path: string, findings: Finding[], targets: readonly string[] = [], context: ReferenceContext = {}): void {
  if (!isObject(value)) { addFinding(findings, finding(path, "reference", "Expected a reference object.")); return; }
  unknownFields(value, ["_type", "_ref", "_weak", "_key"], path, findings);
  if (value._type !== "reference" || typeof value._ref !== "string" || !value._ref.length || value._ref.length > 1024) {
    addFinding(findings, finding(path, "reference", "Reference requires an exact nonempty source ID.")); return;
  }
  if (value._weak !== undefined && typeof value._weak !== "boolean") addFinding(findings, finding(childPath(path, "_weak"), "reference_weak", "Weak flag must be boolean."));
  if (value._key !== undefined && (typeof value._key !== "string" || !value._key.length)) addFinding(findings, finding(childPath(path, "_key"), "key", "Reference key must be nonempty."));
  const target = context.records?.get(value._ref);
  if (!target) {
    const weak = value._weak === true;
    addFinding(findings, { ...finding(childPath(path, "_ref"), context.records ? "missing_reference" : "unchecked_reference", "Exact reference target has not been verified.", true, !weak), disposition: "review" });
  } else if (targets.length && !targets.includes(target._type)) addFinding(findings, finding(childPath(path, "_ref"), "reference_type", "Reference target type is not allowed."));
}