import { inspectPortableText, type PortableText } from "./portable-text";
import { addFinding, childPath, finding, inspectJson, isObject, isSafeUrl, isTimestamp, result, unknownFields, validateReference, type Finding, type JsonValue, type Reference, type ReferenceContext, type ValidationResult } from "./validation";
export type { Finding, JsonValue, Reference, ValidationResult } from "./validation";

type Common = { title?: string; description?: string; required?: boolean; publishRequired?: boolean; private?: boolean };
type StringDescriptor = Common & { type: "string" | "text" | "url" | "date" | "datetime"; minLength?: number; maxLength?: number };
type NumberDescriptor = Common & { type: "number"; min?: number; max?: number; integer?: boolean };
export type Descriptor = StringDescriptor
  | NumberDescriptor
  | (Common & { type: "boolean" | "slug" | "portableText" })
  | (Common & { type: "enum"; options: readonly string[] })
  | (Common & { type: "reference" | "asset"; to: readonly string[] })
  | (Common & { type: "object"; objectType?: string; fields: readonly FieldDefinition[] })
  | (Common & { type: "array"; of: readonly Descriptor[]; minItems?: number; maxItems?: number; keyed?: boolean });
export type FieldDefinition = Descriptor & { name: string };
export type TypeDefinition = {
  name: string;
  type: "document";
  title?: string;
  schemaVersion: number;
  fields: readonly FieldDefinition[];
  /** Reviewed named rules only; no callbacks cross the browser boundary. */
  rules?: readonly ("partnerConsent" | "signalEvidence" | "dictionaryEntries" | "workSummary" | "publicationApproval")[];
};
export type NativeEnvelope = { _id: string; _type: string; _rev: string; _createdAt: string; _updatedAt: string };
export type SourceIdentity = { sourceId: string; logicalId: string; variant: "draft" | "published" };
export function sourceIdentity(id: string): SourceIdentity {
  return { sourceId: id, logicalId: id.startsWith("drafts.") ? id.slice(7) : id, variant: id.startsWith("drafts.") ? "draft" : "published" };
}
type RequiredNames<F extends readonly FieldDefinition[]> = Extract<F[number], { required: true }>["name"];
export type InferFields<F extends readonly FieldDefinition[]> = {
  [P in F[number] as P["name"] extends RequiredNames<F> ? P["name"] : never]: InferValue<P>
} & {
  [P in F[number] as P["name"] extends RequiredNames<F> ? never : P["name"]]?: InferValue<P>
};
export type InferValue<D extends Descriptor> = D extends { type: "enum"; options: readonly (infer V)[] } ? V
  : D extends { type: "number" } ? number
  : D extends { type: "boolean" } ? boolean
  : D extends { type: "reference" | "asset" } ? Reference
  : D extends { type: "slug" } ? { _type: "slug"; current: string }
  : D extends { type: "portableText" } ? PortableText
  : D extends { type: "object"; fields: infer F extends readonly FieldDefinition[] } ? InferFields<F> & (D extends { objectType: infer N extends string } ? { _type: N } : object)
  : D extends { type: "array"; of: infer M extends readonly Descriptor[] } ? (InferValue<M[number]> & (D extends { keyed: true } ? { _key: string } : unknown))[]
  : string;
export type InferDocument<T extends TypeDefinition> = Omit<NativeEnvelope, "_type"> & { _type: T["name"] } & InferFields<T["fields"]>;
export function defineField<const T extends FieldDefinition>(field: T): T { return field; }
export function defineArrayMember<const T extends Descriptor>(member: T): T { return member; }
export function defineType<const T extends TypeDefinition>(schema: T): T { return schema; }

/** Registry owns a frozen JSON snapshot. Invalid code-owned definitions fail at registration, not content validation. */
export type SchemaRegistry<T extends readonly TypeDefinition[] = readonly TypeDefinition[]> = {
  descriptors: T;
  get(name: string): T[number] | undefined;
};
export function createSchemaRegistry<const T extends readonly TypeDefinition[]>(definitions: T): SchemaRegistry<T> {
  if (inspectJson(definitions).length) throw new Error("Schema descriptors must be bounded pure JSON.");
  const names = new Set<string>();
  const fail = () => { throw new Error("Invalid or duplicate CMS schema descriptor."); };
  function checkFields(fields: readonly FieldDefinition[]): void {
    const seen = new Set<string>();
    if (!Array.isArray(fields)) fail();
    for (const field of fields) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(field.name) || seen.has(field.name) || ["constructor", "prototype"].includes(field.name)) fail();
      seen.add(field.name);
      check(field);
    }
  }
  function check(d: Descriptor): void {
    const types = ["string", "text", "url", "date", "datetime", "number", "boolean", "slug", "portableText", "enum", "reference", "asset", "object", "array"];
    if (!types.includes(d.type)) fail();
    if (d.type === "object") checkFields(d.fields);
    if (d.type === "array") {
      if (!Array.isArray(d.of) || !d.of.length) fail();
      const signatures = new Set<string>();
      for (const member of d.of) {
        check(member);
        const signature = member.type === "object" ? member.objectType ?? "object" : member.type;
        if (signatures.has(signature) || (d.of.length > 1 && member.type === "object" && !member.objectType)) fail();
        signatures.add(signature);
      }
    }
    if (d.type === "enum" && (!Array.isArray(d.options) || !d.options.length || d.options.some((s) => typeof s !== "string") || new Set(d.options).size !== d.options.length)) fail();
    if ((d.type === "reference" || d.type === "asset") && (!Array.isArray(d.to) || !d.to.length || d.to.some((s) => typeof s !== "string" || !s))) fail();
    for (const pair of [["min", "max"], ["minLength", "maxLength"], ["minItems", "maxItems"]]) {
      const obj = d as unknown as Record<string, unknown>;
      for (const name of pair) if (obj[name] !== undefined && (typeof obj[name] !== "number" || !Number.isFinite(obj[name]))) fail();
      if (typeof obj[pair[0]] === "number" && typeof obj[pair[1]] === "number" && Number(obj[pair[0]]) > Number(obj[pair[1]])) fail();
    }
  }
  for (const definition of definitions) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(definition.name) || names.has(definition.name) || definition.type !== "document" || !Number.isInteger(definition.schemaVersion) || definition.schemaVersion < 1) fail();
    names.add(definition.name);
    checkFields(definition.fields);
    if (definition.rules?.some((rule) => !["partnerConsent", "signalEvidence", "dictionaryEntries", "workSummary", "publicationApproval"].includes(rule))) fail();
  }
  const snapshot = JSON.parse(JSON.stringify(definitions)) as T;
  function freeze(value: unknown): void {
    if (typeof value !== "object" || value === null) return;
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  freeze(snapshot);
  const map = new Map<string, T[number]>(snapshot.map((d) => [d.name, d]));
  return Object.freeze({ descriptors: snapshot, get: (name: string) => map.get(name) });
}

export type DocumentValidationOptions = ReferenceContext & {
  mode?: "draft" | "publish";
  /** Code-owned, audience-scoped key/placeholder contracts; never derive these from submitted entries. */
  dictionaryContracts?: ReadonlyMap<string, readonly string[]>;
};
const envelopeKeys = ["_id", "_type", "_rev", "_createdAt", "_updatedAt"];
function validateEnvelope(value: Record<string, unknown>, findings: Finding[]): void {
  for (const name of ["_id", "_type", "_rev"]) {
    if (typeof value[name] !== "string" || !value[name].length || value[name].length > 1024) addFinding(findings, finding(childPath("$", name), "envelope", "Required opaque nonempty string."));
  }
  if (value._id === "drafts.") addFinding(findings, finding('$["_id"]', "identity", "Draft logical ID cannot be empty."));
  for (const name of ["_createdAt", "_updatedAt"]) if (!isTimestamp(value[name])) addFinding(findings, finding(childPath("$", name), "timestamp", "Expected valid UTC source timestamp; no replacement time is generated."));
}
export function validateDocument<const T extends readonly TypeDefinition[]>(input: unknown, registry: SchemaRegistry<T>, options: DocumentValidationOptions = {}): ValidationResult<InferDocument<T[number]>> {
  const findings = inspectJson(input);
  if (findings.length) return result(undefined, findings);
  const source = input as JsonValue;
  if (!isObject(input)) return result(source, [finding("$", "document", "Expected a native document object.")]);
  validateEnvelope(input, findings);
  const definition = typeof input._type === "string" ? registry.get(input._type) : undefined;
  if (!definition) {
    addFinding(findings, finding('$["_type"]', "unknown_type", "Unregistered type retained privately; no schema coverage asserted.", true));
    return result(source, findings);
  }
  function fields(value: Record<string, unknown>, definitions: readonly FieldDefinition[], path: string, extra: readonly string[] = []): void {
    unknownFields(value, [...extra, ...definitions.map((f) => f.name)], path, findings);
    for (const field of definitions) {
      const p = childPath(path, field.name);
      if (!Object.hasOwn(value, field.name)) {
        if (field.required) addFinding(findings, finding(p, "required", "Required field is missing."));
        else if (field.publishRequired) addFinding(findings, { ...finding(p, "publish_required", "Field is required before publication.", true), disposition: "review" });
      } else validate(value[field.name], field, p);
    }
  }
  function validate(value: unknown, d: Descriptor, path: string, arrayMember = false): void {
    const mismatch = () => addFinding(findings, finding(path, "type", `Expected ${d.type} value.`));
    switch (d.type) {
      case "string": case "text": case "url": case "date": case "datetime":
        if (typeof value !== "string") { mismatch(); break; }
        if (value.length < (d.minLength ?? 0) || value.length > (d.maxLength ?? 100000)) addFinding(findings, finding(path, "length", "Text length is outside the schema bounds."));
        if (d.type === "url" && !isSafeUrl(value)) addFinding(findings, finding(path, "unsafe_url", "URL is not an allowed navigation URL."));
        if (d.type === "datetime" && !isTimestamp(value)) addFinding(findings, finding(path, "timestamp", "Expected valid UTC timestamp."));
        if (d.type === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !isTimestamp(`${value}T00:00:00Z`))) addFinding(findings, finding(path, "date", "Expected valid calendar date."));
        break;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) { mismatch(); break; }
        if ((d.integer && !Number.isInteger(value)) || value < (d.min ?? -Infinity) || value > (d.max ?? Infinity)) addFinding(findings, finding(path, "number_bounds", "Number is outside the schema bounds."));
        break;
      case "boolean": if (typeof value !== "boolean") mismatch(); break;
      case "enum": if (typeof value !== "string" || !d.options.includes(value)) addFinding(findings, finding(path, "enum", "Expected a registered enum token.")); break;
      case "slug":
        if (!isObject(value)) { mismatch(); break; }
        unknownFields(value, ["_type", "current"], path, findings);
        if (value._type !== "slug" || typeof value.current !== "string" || !value.current.length || value.current.length > 200) addFinding(findings, finding(path, "slug", "Expected native slug object with current string."));
        break;
      case "reference": case "asset": validateReference(value, path, findings, d.to, options); break;
      case "portableText": inspectPortableText(value, path, findings, options); break;
      case "object":
        if (!isObject(value)) { mismatch(); break; }
        if (d.objectType && value._type !== d.objectType) addFinding(findings, finding(childPath(path, "_type"), "object_type", "Object discriminant does not match its descriptor."));
        fields(value, d.fields, path, [...(d.objectType ? ["_type"] : []), ...(arrayMember ? ["_key"] : [])]);
        break;
      case "array": {
        if (!Array.isArray(value)) { mismatch(); break; }
        if (value.length < (d.minItems ?? 0) || value.length > (d.maxItems ?? 2000)) addFinding(findings, finding(path, "array_bounds", "Array length is outside the schema bounds."));
        const keys = new Set<string>();
        value.forEach((member, i) => {
          const p = childPath(path, i);
          if (d.keyed) {
            if (!isObject(member) || typeof member._key !== "string" || !member._key.length || member._key.length > 200) addFinding(findings, finding(p, "key", "Stable array member key required."));
            else if (keys.has(member._key)) addFinding(findings, finding(childPath(p, "_key"), "duplicate_key", "Sibling keys must be unique."));
            else keys.add(member._key);
          }
          const match = d.of.length === 1 ? d.of[0] : d.of.find((candidate) => {
            if (candidate.type === "object") return isObject(member) && member._type === candidate.objectType;
            if (candidate.type === "reference" || candidate.type === "asset") return isObject(member) && member._type === "reference";
            return (candidate.type === "number" && typeof member === "number") || (candidate.type === "boolean" && typeof member === "boolean") || (["string", "text", "url", "date", "datetime", "enum"].includes(candidate.type) && typeof member === "string");
          });
          if (!match) addFinding(findings, finding(p, "unsupported_member", "Unregistered array member retained privately.", true));
          else validate(member, match, p, true);
        });
        break;
      }
    }
  }
  fields(input, definition.fields, "$", [...envelopeKeys, "_system"]);
  if (Object.hasOwn(input, "_system")) addFinding(findings, finding('$["_system"]', "private_system", "Opaque system provenance retained privately; review required.", true));
  applyRules(input, definition, findings, options);
  if (typeof input._id === "string" && input._id.startsWith("drafts.")) addFinding(findings, {
    ...finding('$["_id"]', "draft_variant", "Draft variant requires explicit native promotion before publication.", options.mode !== "publish"), disposition: "review"
  });
  // Typed values are exposed only for fully supported structures. Unknown JSON stays in private source.
  return result(source, findings, findings.some((f) => f.disposition === "quarantine") ? undefined : input as InferDocument<T[number]>);
}

function applyRules(value: Record<string, unknown>, definition: TypeDefinition, findings: Finding[], options: DocumentValidationOptions): void {
  const review = (path: string, code: string, message: string) => addFinding(findings, { ...finding(path, code, message, true), disposition: "review" });
  for (const rule of definition.rules ?? []) {
    if (rule === "publicationApproval" && (!isObject(value.publicationApproval) || value.publicationApproval.status !== "approved")) review('$["publicationApproval"]', "publication_approval", "Explicit publication approval required.");
    if (rule === "workSummary" && typeof value.detailSummary === "string" && value.detailSummary.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim()).length > 3) addFinding(findings, finding('$["detailSummary"]', "summary_sentences", "Work summary is limited to three sentences."));
    if (rule === "partnerConsent") {
      const consent = isObject(value.consent) ? value.consent : {};
      for (const name of ["quote", "likeness", ...(value.logo ? ["mark"] : [])]) if (consent[name] !== true) review(childPath('$["consent"]', name), "consent_required", "Explicit approval is required; provenance is not consent.");
      if (consent.status !== "approved") review('$["consent"]["status"]', "approval_required", "Publication approval must be explicit.");
      if (!value.logo && (typeof value.textBadge !== "string" || !value.textBadge)) review('$["textBadge"]', "text_badge_required", "A text badge fallback is required when no verified logo is supplied.");
      if (typeof value.excerpt === "string" && value.excerpt !== value.quote && !value.omissionMarker) review('$["omissionMarker"]', "omission_marker_required", "Quote excerpts require an explicit omission marker.");
      if (value.logo && value.logoVerified !== true) review('$["logoVerified"]', "logo_verification", "Logo verification required; otherwise use text badge fallback.");
      if (value.relatedWork && value.relatedWorkVerified !== true) review('$["relatedWorkVerified"]', "related_work_verification", "Related work must be verified.");
    }
    if (rule === "signalEvidence") {
      if (value.disclosure !== "verified") review('$["disclosure"]', "illustrative_only", "Illustrative/demo evidence cannot publish as a verified case study.");
      if (!isObject(value.customerApproval) || value.customerApproval.status !== "approved") review('$["customerApproval"]', "customer_approval", "Customer publication approval required.");
      if (Array.isArray(value.findings)) value.findings.forEach((entry, index) => {
        if (isObject(entry) && entry.classification !== "verified") review(childPath(childPath('$["findings"]', index), "classification"), "illustrative_finding", "Illustrative findings cannot be presented as verified outcomes.");
      });
    }
    if (rule === "dictionaryEntries" && Array.isArray(value.entries)) {
      const keys = new Set<string>();
      value.entries.forEach((entry, index) => {
        if (!isObject(entry)) return;
        const p = childPath('$["entries"]', index);
        if (typeof entry.key !== "string" || !/^[a-zA-Z][a-zA-Z0-9]*(?:[._-][a-zA-Z0-9]+)*$/.test(entry.key)) addFinding(findings, finding(childPath(p, "key"), "dictionary_key", "Expected a stable dictionary key."));
        else if (keys.has(entry.key)) addFinding(findings, finding(childPath(p, "key"), "duplicate_dictionary_key", "Dictionary keys must be unique."));
        else keys.add(entry.key);
        const contract = typeof entry.key === "string" ? options.dictionaryContracts?.get(entry.key) : undefined;
        if (!contract) review(childPath(p, "key"), "dictionary_contract_unchecked", "Code-owned dictionary key/placeholder contract has not been verified.");
        else if (!Array.isArray(entry.placeholders) || entry.placeholders.length !== contract.length || contract.some((name) => !entry.placeholders || !(entry.placeholders as unknown[]).includes(name))) addFinding(findings, finding(childPath(p, "placeholders"), "immutable_placeholder_contract", "Submitted placeholders differ from the code-owned contract."));
        if (typeof entry.value === "string" && (entry.value.includes("<") || /\b(?:javascript|data):/i.test(entry.value))) addFinding(findings, finding(childPath(p, "value"), "dictionary_markup", "Dictionary values cannot contain markup or executable URLs."));
        if (entry.format === "icu") review(childPath(p, "format"), "icu_adapter_required", "ICU parser/immutable placeholder contract adapter is not implemented; publication blocked.");
        else if (typeof entry.value === "string" && Array.isArray(entry.placeholders)) {
          const actual = [...entry.value.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map((match) => match[1]);
          const declared = entry.placeholders.filter((v): v is string => typeof v === "string");
          if (new Set(declared).size !== declared.length || declared.some((v) => !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(v)) || actual.some((v) => !declared.includes(v)) || declared.some((v) => !actual.includes(v)) || /[{}]/.test(entry.value.replace(/\{[a-zA-Z][a-zA-Z0-9_]*\}/g, ""))) addFinding(findings, finding(childPath(p, "placeholders"), "placeholder_contract", "Declared placeholders must match the plain text template exactly."));
        }
        if (entry.status !== "approved") review(childPath(p, "status"), "entry_approval", "Dictionary entry is not approved.");
      });
    }
  }
}