import { cmsSchemaRegistry } from "../schemas";
import { sourceIdentity, validateDocument } from "../schema";
import { inspectJson, isObject, type JsonObject, type JsonValue } from "../validation";
import { ImportError, readNdjson, sha256, type SourceRecord, type Snapshot } from "./reader";

export const MAPPING = "registered-drafts-v1";
export const canonical = (value: JsonValue): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
export type Edge = { path: string; sourceRef: string; weak: boolean };
export function references(value: JsonValue): Edge[] {
  const edges: Edge[] = [];
  function walk(node: JsonValue, path: string): void {
    if (!node || typeof node !== "object") return;
    if (!Array.isArray(node) && node._type === "reference") {
      if (typeof node._ref !== "string" || !node._ref || Buffer.byteLength(node._ref) > 512 || Buffer.byteLength(path) > 1024 || (node._weak !== undefined && typeof node._weak !== "boolean")) throw new ImportError("reference");
      edges.push({ path, sourceRef: node._ref, weak: node._weak === true });
      if (edges.length > 200) throw new ImportError("reference_limit");
    }
    for (const [key, child] of Object.entries(node)) walk(child, `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`);
  }
  walk(value, ""); return edges;
}
export type Candidate = SourceRecord & { value: JsonObject; edges: Edge[]; schemaVersion: number; payloadSha256: string };
type Descriptor = { id: string; type: string; reason: string; candidate?: Candidate };
export type ImportPlan = { snapshot: Snapshot; entries: Descriptor[]; candidates: Candidate[]; report: ImportReport };
export type ImportReport = {
  version: 1; mapping: string; snapshot: Snapshot; counts: Record<string, number>;
  reasons: Record<string, number>; eligible: number; publishable: false; limitations: string[];
};
const text = (v: unknown): v is string => typeof v === "string" && !!v && Buffer.byteLength(v) <= 512 && !/[\u0000-\u001f\u007f]/.test(v);
const EXCLUDED = new Map([["mux.apiKey", "excluded_secret"], ["pageNotFound", "excluded_operational"], ["notificationRequest", "excluded_operational"]]);

/** No database imports, source fetches, report payloads or quarantine persistence.
 * Unsupported records stay in the operator's original private read-only source. */
export async function planImport(file: string): Promise<ImportPlan> {
  const entries: Descriptor[] = [], seen = new Set<string>();
  let retained = 0;
  const snapshot = await readNdjson(file, record => {
    const body = record.value;
    if (!isObject(body) || !text(body._id) || !text(body._type)) throw new ImportError("identity", record.line);
    if (seen.has(body._id)) throw new ImportError("duplicate_id", record.line);
    seen.add(body._id);
    // Exclusion happens before source retention, findings or schema work.
    const excluded = EXCLUDED.get(body._type);
    if (excluded) { entries.push({ id: body._id, type: body._type, reason: excluded }); return; }
    const entry: Descriptor = { id: body._id, type: body._type, reason: "quarantined" };
    entries.push(entry);
    if (body._type === "sanity.imageAsset" || body._type === "sanity.fileAsset") { entry.reason = "asset_bytes_unverified"; return; }
    if (inspectJson(body).length) { entry.reason = "unsafe_json"; return; }
    const checked = validateDocument(body, cmsSchemaRegistry, { mode: "draft" });
    if (!checked.valid || !checked.value || checked.findings.some(f => f.disposition === "quarantine")) {
      entry.reason = !cmsSchemaRegistry.get(body._type) ? "unknown_schema" : "invalid_or_unsupported"; return;
    }
    if (sourceIdentity(body._id).variant !== "draft") { entry.reason = "published_variant_unsupported"; return; }
    if (!text(body._rev) || (body.locale !== undefined && !text(body.locale)) || (isObject(body.slug) && !text(body.slug.current))) { entry.reason = "indexed_text"; return; }
    let edges: Edge[];
    try { edges = references(body as JsonObject); } catch { entry.reason = "invalid_reference"; return; }
    retained += Buffer.byteLength(record.raw);
    if (retained > 8 * 1024 * 1024) throw new ImportError("plan_memory_limit");
    entry.candidate = { ...record, value: body as JsonObject, edges, schemaVersion: cmsSchemaRegistry.get(body._type)!.schemaVersion, payloadSha256: sha256(canonical(body as JsonObject)) };
    entry.reason = "eligible";
  });
  // Validate target types against ALL source descriptors, then close the eligible
  // graph to a fixed point. Cycles and forward edges do not need sorting.
  const types = new Map(entries.map(e => [e.id, { _type: e.type }]));
  for (const entry of entries) {
    if (!entry.candidate) continue;
    const checked = validateDocument(entry.candidate.value, cmsSchemaRegistry, { mode: "draft", records: types });
    if (!checked.valid || !checked.value) { entry.reason = "reference_type"; entry.candidate = undefined; }
  }
  let changed: boolean;
  do {
    changed = false;
    const eligible = new Set(entries.filter(e => e.candidate).map(e => e.id));
    for (const entry of entries) {
      if (entry.candidate?.edges.some(e => !e.weak && !eligible.has(e.sourceRef))) {
        entry.reason = "strong_reference_unavailable"; entry.candidate = undefined; changed = true;
      }
    }
  } while (changed);
  const counts: Record<string, number> = { eligible: 0, quarantined: 0, excluded_secret: 0, excluded_operational: 0 };
  const reasons: Record<string, number> = Object.create(null);
  for (const e of entries) {
    const outcome = e.reason === "eligible" || e.reason.startsWith("excluded_") ? e.reason : "quarantined";
    counts[outcome]++; reasons[e.reason] = (reasons[e.reason] ?? 0) + 1;
  }
  const candidates = entries.flatMap(e => e.candidate ? [e.candidate] : []);
  return { snapshot, entries, candidates, report: { version: 1, mapping: MAPPING, snapshot, counts, reasons, eligible: candidates.length, publishable: false,
    limitations: ["Only registered draft schemas; no NCW schema parity or conversion.", "Quarantine is report-only; original private source is retained in place, not copied.", "No asset bytes, fetching, public release, promotion, import jobs or checkpoint resume.", "Apply is one atomic transaction, limited to 100 drafts and 8 MiB retained raw data; deterministic receipt replay only."] } };
}