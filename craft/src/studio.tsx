"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createContentRegistry, type TypeDefinition } from './schema.js';
import { createReferenceIndex, deepEqual, documentTitle, ensureKeys, setField, type ContentDocument, type ImageAssetDocument } from './content-ops.js';
import { validateDocument, publishState, type Path } from './validate.js';
import { randomKey } from './portable-text.js';
import { Field } from './fields.js';
import { StudioContext, fieldId, type StudioApi } from './studio-context.js';
import { ConnectedStudio, type StudioInitial } from './studio-connected.js';
import type { StudioStore } from './studio-store.js';

export type StudioConfig = { schemas: readonly TypeDefinition[]; documents: readonly ContentDocument[]; assets?: readonly ImageAssetDocument[] };
const pathLabel = (path: Path) => path.map(part => typeof part === 'number' ? `item ${part + 1}` : part).join(' › ');

export type ContentStudioProps = {
  config: StudioConfig; initialType?: string; initialDocument?: string; basePath?: string;
  brand?: { name: string; homeHref: string; logoSrc?: string; designSystemHref?: string };
  /** Persistence adapter. Absent: local-draft mode, drafts live in page memory only. Present: documents come from the store, which is the source of truth, and `config.documents` is ignored. */
  store?: StudioStore;
  /** Store mode only: server-prefetched list/record (or a prefetch failure) for the first paint. */
  initial?: StudioInitial;
  /** One honest line shown above the editor in either mode, e.g. what is missing or what publishing does not do yet. */
  notice?: string;
  /** Extra top-bar content, e.g. a sign-out form. */
  topbarSlot?: ReactNode;
  /** Store mode: where a `denied` result sends the editor to sign in again. */
  signInHref?: string;
};

/** Framework-neutral content desk over Sanity-shaped documents. With a `store` it persists through that adapter; without one it keeps local drafts in page memory only. */
export function ContentStudio({ store, initial, signInHref, brand = { name: 'Jongo', homeHref: '/craft' }, ...rest }: ContentStudioProps) {
  if (store) return <ConnectedStudio {...rest} brand={brand} store={store} initial={initial} signInHref={signInHref} />;
  return <LocalStudio {...rest} brand={brand} />;
}

function LocalStudio({ config, initialType, initialDocument, basePath, brand, notice, topbarSlot }: Omit<ContentStudioProps, 'store' | 'initial' | 'signInHref' | 'brand'> & { brand: NonNullable<ContentStudioProps['brand']> }) {
  const registry = useMemo(() => createContentRegistry(config.schemas), [config.schemas]);
  // Original snapshot: supplied documents with any missing or duplicate keys filled in deterministically.
  const original = useMemo(() => config.documents.map(doc => { const schema = registry.get(doc._type); return schema ? ensureKeys(schema, doc) : doc; }), [config.documents, registry]);
  const [documents, setDocuments] = useState<ContentDocument[]>(original);
  const [type, setType] = useState(initialType ?? config.schemas[0]?.name ?? '');
  const [selectedId, setSelectedId] = useState(initialDocument ?? config.documents.find(doc => doc._type === type)?._id ?? '');
  const selected = documents.find(doc => doc._id === selectedId && doc._type === type);
  const [working, setWorking] = useState<ContentDocument | undefined>(selected);
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState({ text: '', count: 0 });
  const [focusTick, setFocusTick] = useState(0);
  const pending = useRef<{ id: string; select?: readonly [number, number] } | null>(null);
  const schema = registry.get(type);
  const dirty = !!working && !!selected && !deepEqual(working, selected);
  const snapshot = original.find(doc => doc._id === selectedId && doc._type === type);
  const edited = !!selected && !!snapshot && !deepEqual(selected, snapshot);
  const index = useMemo(() => createReferenceIndex(documents.map(doc => working && doc._id === working._id ? working : doc), config.assets), [documents, working, config.assets]);
  const issues = useMemo(() => schema && working ? validateDocument(schema, working, index) : [], [schema, working, index]);
  const state = publishState(issues);
  const announce = useCallback((text: string) => setMessage(previous => ({ text, count: previous.count + 1 })), []);
  const focus = useCallback((id: string, select?: readonly [number, number]) => { pending.current = { id, select }; setFocusTick(tick => tick + 1); }, []);
  useEffect(() => {
    const request = pending.current;
    if (!request) return;
    pending.current = null;
    const element = document.getElementById(request.id) as HTMLElement | null;
    element?.focus();
    if (element && request.select && 'setSelectionRange' in element) (element as HTMLInputElement).setSelectionRange(request.select[0], request.select[1]);
  }, [focusTick]);

  const documentHref = (nextType: string, id?: string) => basePath ? `${basePath}/${encodeURIComponent(nextType)}${id ? '/' + encodeURIComponent(id) : ''}` : '#jongo-editor';
  const open = (nextType: string, doc?: ContentDocument) => { setType(nextType); setSelectedId(doc?._id ?? ''); setWorking(doc); announce(''); };
  // Keep the content desk in page memory while providing shareable URLs and browser history.
  useEffect(() => {
    if (!basePath) return;
    const restore = () => {
      const [nextType = config.schemas[0]?.name, id] = window.location.pathname.slice(basePath.length).split('/').filter(Boolean).map(decodeURIComponent);
      const doc = documents.find(item => item._type === nextType && (!id || item._id === id));
      if (doc) open(nextType, doc);
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, [basePath, config.schemas, documents]);
  function choose(nextType: string, id?: string) {
    if (dirty && !window.confirm('Discard unsaved field changes? Saved local drafts also reset on reload.')) return;
    const doc = documents.find(item => item._type === nextType && (!id || item._id === id));
    open(nextType, doc);
    if (basePath) window.history.pushState(null, '', documentHref(nextType, doc?._id));
  }
  const navigate = (event: MouseEvent<HTMLAnchorElement>, nextType: string, id?: string) => { if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return; event.preventDefault(); choose(nextType, id); };
  const jump = (path: Path) => {
    for (let length = path.length; length > 0; length--) {
      const element = document.getElementById(fieldId(working?._id ?? '', path.slice(0, length)));
      if (element) { element.scrollIntoView?.({ block: 'center' }); element.focus(); return; }
    }
  };
  const api: StudioApi | null = working ? { docId: working._id, values: working, issues, index, schemas: registry, makeKey: randomKey, announce, focus } : null;
  const visible = documents.filter(doc => doc._type === type && documentTitle(doc, schema).toLowerCase().includes(query.toLowerCase()));
  const chip = dirty ? 'Unsaved changes' : edited ? 'Local draft (edited)' : 'Original snapshot';
  return <div className="jongo-studio"><a className="jongo-skip" href="#jongo-editor">Skip to editor</a><header className="jongo-topbar"><a className="jongo-brand" href={brand.homeHref}>{brand.logoSrc && <img src={brand.logoSrc} alt="" />}{brand.name}<span>Studio</span></a><span>Content workspace</span>{brand.designSystemHref && <a href={brand.designSystemHref}>Design system ↗</a>}{topbarSlot && <div className="jongo-topbar-slot">{topbarSlot}</div>}</header>
    <div className="jongo-desk"><aside className="jongo-structure"><p className="jongo-eyebrow">Structure</p><h2>Content</h2><nav aria-label="Content structure">{config.schemas.map(item => <a className="jongo-nav-item" href={documentHref(item.name)} key={item.name} aria-current={type === item.name ? 'page' : undefined} onClick={event => navigate(event, item.name)}>{item.title ?? item.name}<span>›</span></a>)}</nav></aside>
      <section className="jongo-documents" aria-label="Document list"><h2>{schema?.title ?? schema?.name ?? 'Documents'}</h2><label>Search documents<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by title" /></label><div className="jongo-document-list">{visible.map(doc => <a className="jongo-nav-item" href={documentHref(doc._type, doc._id)} key={doc._id} aria-current={selectedId === doc._id ? 'page' : undefined} onClick={event => navigate(event, type, doc._id)}><strong>{documentTitle(doc, schema)}</strong><small>{deepEqual(doc, original.find(item => item._id === doc._id)) ? 'Original snapshot' : 'Local draft (edited)'} · {doc._type}</small></a>)}</div>{!visible.length && <p>No matching documents.</p>}</section>
      <main id="jongo-editor" className="jongo-editor" tabIndex={-1}>{notice && <p className="jongo-notice" role="note">{notice}</p>}{schema && working && api ? <StudioContext.Provider value={api}><div className="jongo-editor-heading"><div><p className="jongo-eyebrow">{schema.title ?? schema.name}</p><h1>{documentTitle(working, schema)}</h1></div><span className={`jongo-state ${dirty ? 'jongo-dirty' : ''}`}>{chip}</span></div><p className="jongo-help">Drafts are kept in page memory only. Reloading or leaving resets all changes. Saving does not publish to the website: persistence and publishing are not connected.</p>
        <section className="jongo-summary" aria-labelledby="jongo-checks-title" data-publish-ready={state.ready ? 'true' : 'false'}>
          <h2 id="jongo-checks-title">Document checks</h2>
          <p><strong className={state.ready ? 'jongo-ready' : 'jongo-blocked'}>{state.ready ? 'Publish-ready checks passed' : `Not publish-ready: ${state.errors} blocking ${state.errors === 1 ? 'issue' : 'issues'}`}</strong>{state.warnings > 0 && ` · ${state.warnings} ${state.warnings === 1 ? 'note' : 'notes'} about preserved content`}</p>
          <p className="jongo-hint">Checks run locally against the schema. They do not publish anything, and a draft with issues can still be saved locally.</p>
          {issues.length > 0 && <ul className="jongo-summary-list">{issues.slice(0, 20).map((issue, i) => <li key={i}><button type="button" className="jongo-link" onClick={() => jump(issue.path)}><span className={issue.severity === 'error' ? 'jongo-error' : 'jongo-warning'}>{issue.severity === 'error' ? 'Error' : 'Note'}</span> {pathLabel(issue.path)}: {issue.message}</button></li>)}{issues.length > 20 && <li>…and {issues.length - 20} more.</li>}</ul>}
        </section>
        <form noValidate onSubmit={event => {
          event.preventDefault();
          setDocuments(previous => previous.map(doc => doc._id === working._id ? working : doc));
          announce(state.ready ? 'Draft saved in local page memory only. No website content was published.' : `Draft saved in local page memory only with ${state.errors} blocking ${state.errors === 1 ? 'issue' : 'issues'}. It is not publish-ready and nothing was published.`);
        }}>
          {schema.fields.map(field => <Field key={field.name} d={field} label={field.title ?? field.name} path={[field.name]} value={working[field.name]} onChange={next => { setWorking(setField(working, field.name, next) as ContentDocument); announce(''); }} />)}
          <div className="jongo-savebar"><button className="jongo-primary" type="submit" disabled={!dirty}>Save local draft</button><button type="button" disabled={!dirty} onClick={() => { setWorking(selected); announce('Unsaved changes reset to the last local draft.'); }}>Reset changes</button><button type="button" disabled={!edited && !dirty} onClick={() => { if (snapshot) { setDocuments(previous => previous.map(doc => doc._id === snapshot._id ? snapshot : doc)); setWorking(snapshot); announce('Document reverted to its original snapshot.'); } }}>Revert to original snapshot</button></div>
          <div role="status" aria-live="polite" aria-atomic="true" className="jongo-live">{message.text}{message.count % 2 ? '\u200b' : ''}</div></form><details><summary>Schema information</summary><p>{schema.name} · version {schema.schemaVersion} · {schema.fields.length} registered fields · {working._id}</p></details></StudioContext.Provider> : <p>Select a document to begin.</p>}</main>
    </div></div>;
}