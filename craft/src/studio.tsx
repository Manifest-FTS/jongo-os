"use client";
import { useEffect, useState, type ChangeEvent, type MouseEvent } from 'react';
import type { ContentSchema } from './shell.js';

export type ContentDocument = { id: string; type: string; title: string; values: Record<string, string> };
export type StudioConfig = { schemas: readonly ContentSchema[]; documents: readonly ContentDocument[] };
export function createContentRegistry(schemas: readonly ContentSchema[]) {
  const registry = new Map<string, ContentSchema>();
  for (const schema of schemas) {
    if (!/^[a-zA-Z][\w-]*$/.test(schema.name) || registry.has(schema.name) || schema.type !== 'document' || schema.schemaVersion < 1) throw new Error('Invalid or duplicate content schema');
    const names = new Set<string>();
    for (const field of schema.fields) {
      if (!/^[a-zA-Z][\w-]*$/.test(field.name) || names.has(field.name) || !['string', 'text', 'enum'].includes(field.type) || (field.type === 'enum' && !field.options?.length)) throw new Error('Invalid content field');
      names.add(field.name);
    }
    registry.set(schema.name, schema);
  }
  return registry;
}
export function validateContent(schema: ContentSchema, values: Record<string, string>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of schema.fields) {
    const value = values[field.name] ?? '';
    if (typeof value !== 'string') errors[field.name] = 'Enter text.';
    else if (field.required && !value.trim()) errors[field.name] = 'This field is required.';
    else if (value.length > (field.maxLength ?? 5000)) errors[field.name] = `Use at most ${field.maxLength ?? 5000} characters.`;
    else if (field.type === 'enum' && value && !field.options?.includes(value)) errors[field.name] = 'Choose a registered option.';
  }
  for (const key of Object.keys(values)) if (!schema.fields.some(field => field.name === key)) errors[key] = 'Unregistered field.';
  return errors;
}

/** Framework-neutral content desk. No operational adapters, auth, publishing, persistence or network. */
export function ContentStudio({ config, initialType, initialDocument, basePath, brand = { name: 'Jongo', homeHref: '/craft' } }: {
  config: StudioConfig; initialType?: string; initialDocument?: string; basePath?: string;
  brand?: { name: string; homeHref: string; logoSrc?: string; designSystemHref?: string };
}) {
  const registry = createContentRegistry(config.schemas);
  const [documents, setDocuments] = useState(() => config.documents.map(doc => ({ ...doc, values: { ...doc.values } })));
  const [type, setType] = useState(initialType ?? config.schemas[0]?.name ?? '');
  const [selectedId, setSelectedId] = useState(initialDocument ?? config.documents.find(doc => doc.type === type)?.id ?? '');
  const selected = documents.find(doc => doc.id === selectedId && doc.type === type);
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...selected?.values }));
  const [query, setQuery] = useState(''), [errors, setErrors] = useState<Record<string, string>>({}), [notice, setNotice] = useState('');
  const schema = registry.get(type);
  const dirty = JSON.stringify(values) !== JSON.stringify(selected?.values ?? {});
  const documentHref = (nextType: string, id?: string) => basePath ? `${basePath}/${encodeURIComponent(nextType)}${id ? '/' + encodeURIComponent(id) : ''}` : '#jongo-editor';
  // Keep the content desk in page memory while providing shareable URLs and browser history.
  useEffect(() => {
    if (!basePath) return;
    const restore = () => {
      const [nextType = config.schemas[0]?.name, id] = window.location.pathname.slice(basePath.length).split('/').filter(Boolean).map(decodeURIComponent);
      const doc = documents.find(item => item.type === nextType && (!id || item.id === id));
      if (!doc) return;
      setType(nextType); setSelectedId(doc.id); setValues({ ...doc.values }); setErrors({}); setNotice('');
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, [basePath, config.schemas, documents]);
  function choose(nextType: string, id?: string) {
    if (dirty && !window.confirm('Discard unsaved field changes? Saved local drafts also reset on reload.')) return;
    const doc = documents.find(item => item.type === nextType && (!id || item.id === id));
    setType(nextType); setSelectedId(doc?.id ?? ''); setValues({ ...doc?.values }); setErrors({}); setNotice('');
    if (basePath) window.history.pushState(null, '', documentHref(nextType, doc?.id));
  }
  const navigate = (event: MouseEvent<HTMLAnchorElement>, nextType: string, id?: string) => { if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return; event.preventDefault(); choose(nextType, id); };
  return <div className="jongo-studio"><a className="jongo-skip" href="#jongo-editor">Skip to editor</a><header className="jongo-topbar"><a className="jongo-brand" href={brand.homeHref}>{brand.logoSrc && <img src={brand.logoSrc} alt="" />}{brand.name}<span>Studio</span></a><span>Content workspace</span>{brand.designSystemHref && <a href={brand.designSystemHref}>Design system ↗</a>}</header>
    <div className="jongo-desk"><aside className="jongo-structure"><p className="jongo-eyebrow">Structure</p><h2>Content</h2><nav aria-label="Content structure">{config.schemas.map(item => <a className="jongo-nav-item" href={documentHref(item.name)} key={item.name} aria-current={type === item.name ? 'page' : undefined} onClick={event => navigate(event, item.name)}>{item.title}<span>›</span></a>)}</nav></aside>
      <section className="jongo-documents" aria-label="Document list"><h2>{schema?.title ?? 'Documents'}</h2><label>Search documents<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by title" /></label><div className="jongo-document-list">{documents.filter(doc => doc.type === type && doc.title.toLowerCase().includes(query.toLowerCase())).map(doc => <a className="jongo-nav-item" href={documentHref(doc.type, doc.id)} key={doc.id} aria-current={selectedId === doc.id ? 'page' : undefined} onClick={event => navigate(event, type, doc.id)}><strong>{doc.title}</strong><small>Local draft · {doc.type}</small></a>)}</div>{!documents.some(doc => doc.type === type && doc.title.toLowerCase().includes(query.toLowerCase())) && <p>No matching documents.</p>}</section>
      <main id="jongo-editor" className="jongo-editor" tabIndex={-1}>{schema && selected ? <><div className="jongo-editor-heading"><div><p className="jongo-eyebrow">{schema.title}</p><h1>{selected.title}</h1></div><span className={`jongo-state ${dirty ? 'jongo-dirty' : ''}`}>{dirty ? 'Unsaved changes' : 'Local draft'}</span></div><p className="jongo-help">Drafts are kept in page memory only. Reloading or leaving resets all changes. Saving does not publish to the website.</p>
        <form noValidate onSubmit={event => { event.preventDefault(); const findings = validateContent(schema, values); setErrors(findings); if (Object.keys(findings).length) { setNotice('Review the highlighted fields. Nothing was saved.'); return; } setDocuments(previous => previous.map(doc => doc.id === selectedId ? { ...doc, values: { ...values } } : doc)); setNotice('Draft saved in local page memory only. No website content was published.'); }}>
          {schema.fields.map(field => { const id = `jongo-${selected.id}-${field.name}`; const props = { id, value: values[field.name] ?? '', required: field.required, maxLength: field.maxLength ?? 5000, 'aria-invalid': !!errors[field.name], 'aria-describedby': errors[field.name] ? id + '-error' : undefined, onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => { setValues(previous => ({ ...previous, [field.name]: event.target.value })); setErrors({}); setNotice(''); } }; return <div className="jongo-field" key={field.name}><label htmlFor={id}>{field.title ?? field.name}{field.required && <span aria-label="required"> *</span>}</label>{field.type === 'text' ? <textarea {...props} rows={5} /> : field.type === 'enum' ? <select {...props}><option value="">Choose an option</option>{field.options?.map(option => <option key={option}>{option}</option>)}</select> : <input {...props} type="text" />}{errors[field.name] && <p id={id + '-error'} className="jongo-error">{errors[field.name]}</p>}</div>; })}
          <div className="jongo-savebar"><button className="jongo-primary" type="submit" disabled={!dirty}>Save local draft</button><button type="button" disabled={!dirty && !Object.keys(errors).length} onClick={() => { setValues({ ...selected.values }); setErrors({}); setNotice('Unsaved changes reset to the last local draft.'); }}>Reset changes</button></div><p role="status">{notice}</p></form><details><summary>Schema information</summary><p>{schema.name} · version {schema.schemaVersion} · {schema.fields.length} registered fields</p></details></> : <p>Select a document to begin.</p>}</main>
    </div></div>;
}