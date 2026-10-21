"use client";

import React, { useId, useState } from "react";
import { createSchemaRegistry, validateDocument, type FieldDefinition, type Finding, type TypeDefinition } from "@/lib/cms/schema";
import { childPath, LIMITS } from "@/lib/cms/validation";
import { cmsFormValues, parseCmsFields, type Values } from "@/lib/cms/form";
import styles from "./CmsFormBuilder.module.css";

const NOTICE = "Schema preview only. Nothing is saved or published.";
export type DraftForm = {
  initialDocument: Record<string, unknown>;
  onSave: (values: Values) => Promise<{ message: string; findings?: Finding[] }>;
};
export type CmsFormBuilderProps = { schemas: readonly TypeDefinition[]; canAuthor: boolean; draft?: DraftForm };

/** Only findings leave validation: no source DTO, publish eligibility or mock save result. */
export function validateSchemaPreview(schema: TypeDefinition, values: Values): Finding[] {
  const document: Record<string, unknown> = {
    // Local validator envelope only; these are not persisted document identities or revisions.
    _id: "schema-preview", _type: schema.name, _rev: "local-only",
    _createdAt: "2000-01-01T00:00:00Z", _updatedAt: "2000-01-01T00:00:00Z"
  };
  const { fields, errors } = parseCmsFields(schema, values);
  Object.assign(document, fields);
  const findings = validateDocument(document, createSchemaRegistry([schema]), { mode: "draft" }).findings;
  return [...errors, ...findings.filter((item) => !errors.some((error) => error.path === item.path))];
}

function fieldHelp(field: FieldDefinition): string {
  const notes = [field.description, `Type: ${field.type}.`];
  if (field.publishRequired) notes.push("Required before publication; this preview cannot publish.");
  if (field.private) notes.push("Private schema field; do not enter sensitive information in this preview.");
  if (field.type === "reference" || field.type === "asset") notes.push(`Reference JSON object: edit _ref (exact source ID), retaining _type, _weak and _key. Plain ID strings are not accepted. Allowed targets: ${field.to.join(", ")}. Target existence and tenant scope are not verified here; no picker or upload is connected.`);
  if (["string", "text", "url", "date", "datetime", "enum"].includes(field.type)) notes.push("Blank is an explicit empty string; use Unset field to omit the field. Schema constraints still apply.");
  if (field.type === "array" || field.type === "object" || field.type === "portableText") notes.push("Bounded JSON editor; schema validation includes nested values. A nested visual builder is future work.");
  if (field.type === "array") notes.push(`Items: ${field.minItems ?? 0}–${field.maxItems ?? LIMITS.array}.${field.keyed ? " Stable unique _key values are required." : ""}`);
  if (field.type === "object" && field.objectType) notes.push(`Required _type: ${field.objectType}.`);
  if (field.type === "number") notes.push(`${field.integer ? "Integer. " : ""}Minimum: ${field.min ?? "unbounded"}; maximum: ${field.max ?? "unbounded"}.`);
  if ("minLength" in field || "maxLength" in field) notes.push(`Length: ${field.minLength ?? 0}–${field.maxLength ?? LIMITS.string}.`);
  return notes.filter(Boolean).join(" ");
}

function SchemaPreview({ schema, canAuthor, draft }: { schema: TypeDefinition; canAuthor: boolean; draft?: DraftForm }) {
  const prefix = useId();
  const [values, setValues] = useState<Values>(draft ? cmsFormValues(schema, draft.initialDocument) : {});
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const update = (name: string, value: string | boolean) => {
    setValues((previous) => ({ ...previous, [name]: value }));
    setFindings(null);
  };
  const fieldId = (name: string) => `${prefix}-${name}`;
  return (
    <section className={styles.preview} aria-label={`${schema.title ?? schema.name} schema preview`}>
      <h3>{schema.title ?? schema.name}</h3>
      <p className={styles.meta}>{schema.name} · Schema version {schema.schemaVersion} · Registered descriptor</p>
      <p>{draft ? "Private draft editor. Saving never publishes content." : NOTICE}</p>
      {!draft && <p className={styles.help}>No dataset or stored document is connected. Local validation does not verify reference scope, approvals, dictionary contracts, or publication readiness.</p>}
      {!canAuthor && <p className={styles.readonly}>{draft ? "Read-only draft. Authoring is unavailable; inputs and saving are disabled." : "Read-only schema preview. Authoring entitlement is not available; input and validation controls are disabled."}</p>}
      <form noValidate onSubmit={async (event) => {
        event.preventDefault();
        if (!canAuthor || saving) return;
        if (!draft) { setFindings(validateSchemaPreview(schema, values)); return; }
        setSaving(true);
        try {
          const result = await draft.onSave(values);
          setFindings(result.findings ?? null);
          setMessage(result.message);
        } catch { setMessage("Draft save unavailable. Your inputs have been retained; retry the same request."); }
        finally { setSaving(false); }
      }}>
        <fieldset disabled={!canAuthor || saving} className={styles.fields}>
          <legend>{draft ? "Draft fields" : "Local preview fields"}</legend>
          {schema.fields.map((field) => {
            const id = fieldId(field.name);
            const path = childPath("$", field.name);
            const issues = findings?.filter((item) => item.path === path || item.path.startsWith(`${path}[`)) ?? [];
            const props = {
              id, name: field.name, required: field.required, "aria-invalid": issues.length ? true as const : undefined,
              "aria-describedby": `${id}-help${issues.length ? ` ${id}-errors` : ""}`, className: styles.control
            };
            const value = String(values[field.name] ?? "");
            let control;
            if (field.type === "boolean") control = <select {...props} value={values[field.name] === undefined ? "" : String(values[field.name])} onChange={(e) => update(field.name, e.target.value === "" ? "" : e.target.value === "true")}><option value="">Not set</option><option value="true">True</option><option value="false">False</option></select>;
            else if (field.type === "enum") control = <select {...props} value={value} onChange={(e) => update(field.name, e.target.value)}><option value="">Select a value</option>{field.options.map((option) => <option key={option} value={option}>{option}</option>)}</select>;
            else if (["text", "reference", "asset", "object", "array", "portableText"].includes(field.type)) control = <textarea {...props} rows={field.type === "text" ? 4 : 7} maxLength={LIMITS.string} value={value} onChange={(e) => update(field.name, e.target.value)} spellCheck={field.type === "text"} />;
            else control = <input {...props} type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"} inputMode={field.type === "url" ? "url" : undefined} min={field.type === "number" ? field.min : undefined} max={field.type === "number" ? field.max : undefined} step={field.type === "number" ? field.integer ? 1 : "any" : undefined} maxLength={"maxLength" in field ? field.maxLength : LIMITS.string} value={value} onChange={(e) => update(field.name, e.target.value)} />;
            return <div className={styles.field} key={field.name}>
              <label htmlFor={id}>{field.title ?? field.name}{field.required ? " (required)" : " (optional)"}</label>
              <p id={`${id}-help`} className={styles.help}>{fieldHelp(field)}</p>
              {control}
              <button type="button" onClick={() => {
                setValues((previous) => { const next = { ...previous }; delete next[field.name]; return next; });
                setFindings(null);
              }}>Unset field: {field.title ?? field.name}</button>
              <span className={styles.help}>{Object.hasOwn(values, field.name) ? "Field set" : "Field absent"}</span>
              {issues.length > 0 && <ul id={`${id}-errors`} className={styles.errors}>{issues.map((item, i) => <li key={i}>{item.message}</li>)}</ul>}
            </div>;
          })}
          <button className={styles.validate} type="submit">{draft ? saving ? "Saving draft…" : "Save draft" : "Validate locally"}</button>
        </fieldset>
      </form>
      <div role="status" aria-live="polite" className={styles.status}>
        {message && <p>{message}</p>}
        {!draft && findings !== null && <p>{findings.length ? `Local validation returned ${findings.length} finding(s). Review errors and unresolved checks below.` : "Local schema checks passed. This is not publication authorization."} {NOTICE}</p>}
      </div>
      {findings && findings.length > 0 && <section aria-label="Validation summary" className={styles.summary}>
        <h4>Validation findings</h4>
        <ul>{findings.map((item, i) => {
          const field = schema.fields.find((candidate) => item.path === childPath("$", candidate.name) || item.path.startsWith(`${childPath("$", candidate.name)}[`));
          return <li key={i}>{field ? <a href={`#${fieldId(field.name)}`}>{item.path}</a> : item.path}: {item.message} ({item.severity})</li>;
        })}</ul>
      </section>}
      <details className={styles.descriptor}><summary>Registered JSON schema descriptor</summary><pre>{JSON.stringify(schema, null, 2)}</pre></details>
    </section>
  );
}

export default function CmsFormBuilder({ schemas, canAuthor, draft }: CmsFormBuilderProps) {
  const id = useId();
  const [selected, setSelected] = useState(schemas[0]?.name ?? "");
  const schema = schemas.find((item) => item.name === selected) ?? schemas[0];
  return <div className={styles.builder}>
    <label htmlFor={id}>Registered schema type</label>
    <select id={id} disabled={!!draft} className={styles.control} value={schema?.name ?? ""} onChange={(event) => setSelected(event.target.value)}>
      {schemas.map((item) => <option key={item.name} value={item.name}>{item.title ?? item.name}</option>)}
    </select>
    {schema ? <SchemaPreview key={`${JSON.stringify(schema)}:${canAuthor}`} schema={schema} canAuthor={canAuthor} draft={draft} /> : <p>No registered schemas are available. {NOTICE}</p>}
  </div>;
}