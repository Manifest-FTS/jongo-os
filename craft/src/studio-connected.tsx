"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createContentRegistry } from './schema.js';
import { createReferenceIndex, deepEqual, documentTitle, ensureKeys, setField, type ContentDocument } from './content-ops.js';
import { validateDocument, publishState, type Path } from './validate.js';
import { randomKey } from './portable-text.js';
import { Field } from './fields.js';
import { StudioContext, fieldId, type StudioApi } from './studio-context.js';
import { MutationKeys, settle, statusDetail, statusLabel, type StudioDocSummary, type StudioFailure, type StudioRecord, type StudioResult, type StudioStore } from './studio-store.js';
import type { StudioConfig } from './studio.js';

export type StudioInitial = {
  /** Server-prefetched list, so the first paint is not empty. Omit to let the Studio call `store.list()` on mount. */
  documents?: readonly StudioDocSummary[];
  /** Server-prefetched record of the document named by `initialDocument`. */
  record?: StudioRecord;
  /** The prefetch failed: the Studio renders an unavailable state with a retry instead of the list. */
  error?: StudioFailure;
};
export type ConnectedStudioProps = {
  config: StudioConfig; store: StudioStore; initial?: StudioInitial; initialType?: string; initialDocument?: string; basePath?: string;
  brand: { name: string; homeHref: string; logoSrc?: string; designSystemHref?: string };
  notice?: string; topbarSlot?: ReactNode; signInHref?: string;
};
type Operation = 'loading' | 'saving' | 'publishing' | 'unpublishing' | 'discarding';
const BUSY_LABEL: Record<Operation, string> = { loading: 'Loading…', saving: 'Saving…', publishing: 'Publishing…', unpublishing: 'Unpublishing…', discarding: 'Discarding…' };
const PROBLEM_TITLE: Record<StudioFailure['code'], string> = { conflict: 'Conflict: this document changed elsewhere', invalid: 'The server did not accept this document', denied: 'Not allowed', unavailable: 'Storage unavailable' };
const ENVELOPE = ['_rev', '_createdAt', '_updatedAt'];
const pathLabel = (path: Path) => path.map(part => typeof part === 'number' ? `item ${part + 1}` : part).join(' › ');
const stripEnvelope = (doc: ContentDocument): ContentDocument => { const next = { ...doc }; for (const key of ENVELOPE) delete next[key]; return next; };

/** Studio backed by a host-supplied `StudioStore`. The store is the only persistence boundary; this component never imports server code. */
export function ConnectedStudio({ config, store, initial, initialType, initialDocument, basePath, brand, notice, topbarSlot, signInHref }: ConnectedStudioProps) {
  const registry = useMemo(() => createContentRegistry(config.schemas), [config.schemas]);
  const adopt = useCallback((record: StudioRecord): StudioRecord => {
    const schema = registry.get(record.doc._type);
    return { ...record, doc: schema ? ensureKeys(schema, record.doc) : record.doc };
  }, [registry]);
  const [summaries, setSummaries] = useState<readonly StudioDocSummary[]>(initial?.documents ?? []);
  const [listError, setListError] = useState<StudioFailure | null>(initial?.error ?? null);
  const [listing, setListing] = useState(!initial);
  const [type, setType] = useState(initialType ?? initial?.record?.doc._type ?? config.schemas[0]?.name ?? '');
  const [selectedId, setSelectedId] = useState(initialDocument ?? initial?.record?.doc._id ?? '');
  const [record, setRecord] = useState<StudioRecord | undefined>(() => initial?.record ? adopt(initial.record) : undefined);
  const [working, setWorking] = useState<ContentDocument | undefined>(record?.doc);
  const [busy, setBusy] = useState<Operation | null>(null);
  const [problem, setProblem] = useState<StudioFailure | null>(null);
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState({ text: '', count: 0 });
  const [focusTick, setFocusTick] = useState(0);
  const busyRef = useRef(false);
  const keys = useRef(new MutationKeys());
  const pending = useRef<{ id: string; select?: readonly [number, number] } | null>(null);
  const restoreFocus = useRef<string | null>(null);
  const schema = registry.get(type);
  const dirty = !!working && !!record && !deepEqual(working, record.doc);
  const titleField = useCallback((docType: string) => { const definition = registry.get(docType); return definition?.preview?.title ?? definition?.fields.find(field => field.type === 'string')?.name; }, [registry]);
  const index = useMemo(() => {
    const known = summaries.filter(item => !(working && item.id === working._id)).map(item => { const field = titleField(item.type); return { _id: item.id, _type: item.type, ...(field ? { [field]: item.title } : {}) }; });
    return createReferenceIndex(working ? [...known, working] : known, config.assets);
  }, [summaries, working, config.assets, titleField]);
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
  // A disabled button that had focus drops it; give it back once the operation ends.
  useEffect(() => {
    if (busy || !restoreFocus.current) return;
    const element = document.getElementById(restoreFocus.current) as HTMLElement | null;
    restoreFocus.current = null;
    if (element && (document.activeElement === document.body || document.activeElement === null) && !(element as HTMLButtonElement).disabled) element.focus();
  }, [busy]);

  const upsertSummary = useCallback((next: StudioRecord) => {
    const doc = next.doc;
    const entry: StudioDocSummary = { id: doc._id, type: doc._type, title: documentTitle(doc, registry.get(doc._type)), variant: next.variant, hasPublished: next.variant === 'published' || !!next.published, ...(typeof doc._updatedAt === 'string' ? { updatedAt: doc._updatedAt } : {}) };
    setSummaries(previous => previous.some(item => item.id === entry.id) ? previous.map(item => item.id === entry.id ? entry : item) : [...previous, entry]);
  }, [registry]);
  const show = useCallback((next: StudioRecord) => { const adopted = adopt(next); setRecord(adopted); setWorking(adopted.doc); setSelectedId(adopted.doc._id); setType(adopted.doc._type); upsertSummary(adopted); return adopted; }, [adopt, upsertSummary]);

  const refreshList = useCallback(async () => {
    setListing(true);
    const result = await settle(() => store.list());
    if (result.ok) { setSummaries(result.documents); setListError(null); } else setListError(result);
    setListing(false);
    return result;
  }, [store]);
  const loadDocument = useCallback(async (id: string, doneText = '') => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy('loading'); setProblem(null);
    const result = await settle(() => store.load(id));
    busyRef.current = false; setBusy(null);
    if (result.ok) { keys.current.clear(); show(result); announce(doneText || 'Document loaded.'); } else setProblem(result);
  }, [store, show, announce]);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!initial) void refreshList().then(result => { if (result.ok && initialDocument && result.documents.some(item => item.id === initialDocument)) void loadDocument(initialDocument); });
    else if (initialDocument && !initial.record && initial.documents?.some(item => item.id === initialDocument)) void loadDocument(initialDocument);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount
  }, []);

  const documentHref = (nextType: string, id?: string) => basePath ? `${basePath}/${encodeURIComponent(nextType)}${id ? '/' + encodeURIComponent(id) : ''}` : '#jongo-editor';
  const confirmLeave = () => !dirty || window.confirm('Discard unsaved field changes? They have not been saved.');
  const open = useCallback((nextType: string, id?: string) => {
    setType(nextType); setSelectedId(id ?? ''); setRecord(undefined); setWorking(undefined); setProblem(null); announce('');
    if (id) void loadDocument(id);
  }, [announce, loadDocument]);
  useEffect(() => {
    if (!basePath) return;
    const restore = () => {
      const [nextType = config.schemas[0]?.name, id] = window.location.pathname.slice(basePath.length).split('/').filter(Boolean).map(decodeURIComponent);
      if (nextType) open(nextType, id && summaries.some(item => item.id === id && item.type === nextType) ? id : undefined);
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, [basePath, config.schemas, summaries, open]);
  function choose(nextType: string, id?: string) {
    if (busyRef.current || !confirmLeave()) return;
    open(nextType, id);
    if (basePath) window.history.pushState(null, '', documentHref(nextType, id));
  }
  const navigate = (event: MouseEvent<HTMLAnchorElement>, nextType: string, id?: string) => { if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return; event.preventDefault(); choose(nextType, id); };
  const jump = (path: Path) => {
    for (let length = path.length; length > 0; length--) {
      const element = document.getElementById(fieldId(working?._id ?? '', path.slice(0, length)));
      if (element) { element.scrollIntoView?.({ block: 'center' }); element.focus(); return; }
    }
  };

  async function mutate(operation: Exclude<Operation, 'loading'>, trigger: string, call: () => Promise<StudioResult<StudioRecord>>, done: string) {
    if (busyRef.current) return;
    busyRef.current = true; restoreFocus.current = trigger; setBusy(operation); setProblem(null); announce(BUSY_LABEL[operation]);
    const result = await settle(call);
    busyRef.current = false; setBusy(null);
    if (result.ok) { keys.current.clear(); show(result); announce(done); } else setProblem(result);
  }
  const save = () => {
    if (!record || !working || !dirty) return;
    const doc = stripEnvelope(working), expect = { nativeRev: record.nativeRev, lockVersion: record.lockVersion };
    void mutate('saving', 'jongo-save', () => store.saveDraft(doc, { ...expect, mutationKey: keys.current.keyFor('save', doc._id, expect, doc) }), 'Draft saved. It is not published.');
  };
  const publish = () => {
    if (!record || !working) return;
    const id = working._id, expect = { nativeRev: record.nativeRev, lockVersion: record.lockVersion };
    void mutate('publishing', 'jongo-publish', () => store.publish(id, { ...expect, mutationKey: keys.current.keyFor('publish', id, expect) }), 'Published.');
  };
  const unpublish = () => {
    if (!record?.published || !working || !window.confirm('Unpublish this document? The published version is withdrawn and a draft is kept.')) return;
    const id = working._id, expect = { nativeRev: record.published.nativeRev, lockVersion: record.published.lockVersion };
    void mutate('unpublishing', 'jongo-unpublish', () => store.unpublish(id, { ...expect, mutationKey: keys.current.keyFor('unpublish', id, expect) }), 'Unpublished. The document is now a draft.');
  };
  const discard = () => {
    if (!record || !working || !window.confirm('Discard the saved draft and return to the published version? Draft changes are not recoverable from the studio.')) return;
    const id = working._id, expect = { nativeRev: record.nativeRev, lockVersion: record.lockVersion };
    void mutate('discarding', 'jongo-discard', () => store.discardDraft(id, { ...expect, mutationKey: keys.current.keyFor('discard', id, expect) }), 'Draft discarded. Showing the published version.');
  };

  const api: StudioApi | null = working ? { docId: working._id, values: working, issues, index, schemas: registry, makeKey: randomKey, announce, focus } : null;
  const visible = summaries.filter(item => item.type === type && item.title.toLowerCase().includes(query.toLowerCase()));
  const saveState = busy ?? (problem?.code === 'conflict' ? 'conflict' : problem ? 'error' : dirty ? 'dirty' : 'saved');
  const chip = busy ? BUSY_LABEL[busy] : problem?.code === 'conflict' ? 'Conflict' : problem ? 'Error' : dirty ? 'Unsaved changes' : 'Saved';
  const canPublish = !!record && record.variant === 'draft' && !dirty && state.ready && !busy;
  const publishHint = !record ? '' : record.variant === 'published' ? 'Published and up to date: nothing to publish.' : dirty ? 'Save your changes before publishing.' : !state.ready ? 'Fix the blocking issues above to enable publishing.' : '';
  const stateOf = (item: StudioDocSummary) => item.variant === 'published' ? 'Published' : item.hasPublished ? 'Draft changes' : 'Draft';
  const unavailable = listError ?? null;
  const editorBody = schema && working && record && api ? <StudioContext.Provider value={api}>
    <div className="jongo-editor-heading"><div><p className="jongo-eyebrow">{schema.title ?? schema.name}</p><h1>{documentTitle(working, schema)}</h1></div>
      <span className="jongo-badges"><span className={`jongo-state jongo-status jongo-status-${statusLabel(record).toLowerCase()}`} data-doc-status={statusLabel(record).toLowerCase()}>{statusLabel(record)}</span><span className={`jongo-state ${saveState === 'dirty' || saveState === 'conflict' || saveState === 'error' ? 'jongo-dirty' : ''}`} data-save-state={saveState}>{chip}</span></span></div>
    <p className="jongo-help">{statusDetail(record)} Changes are saved as drafts in the connected store; publishing is a separate, explicit step.</p>
    {problem && <div role="alert" className={`jongo-problem jongo-problem-${problem.code}`} data-problem={problem.code}>
      <h2>{PROBLEM_TITLE[problem.code]}</h2>
      <p>{problem.message}</p>
      {problem.code === 'conflict' && <><p>Your edits are still on this page and were not saved. Reload latest loads the newest saved version and discards your unsaved edits here.</p><button type="button" onClick={() => { if (!busyRef.current) void loadDocument(working._id, 'Reloaded the latest saved version. Your unsaved edits were discarded.'); }} disabled={!!busy}>Reload latest</button></>}
      {problem.fieldErrors?.length ? <ul className="jongo-summary-list">{problem.fieldErrors.slice(0, 20).map((item, i) => <li key={i}>{item.path.length ? `${pathLabel(item.path)}: ` : ''}{item.message}</li>)}</ul> : null}
      {problem.code === 'denied' && signInHref && <p><a className="jongo-link" href={signInHref}>Sign in again</a></p>}
      {problem.code === 'unavailable' && <p className="jongo-hint">Pressing the same button again retries the same request safely.</p>}
    </div>}
    <section className="jongo-summary" aria-labelledby="jongo-checks-title" data-publish-ready={state.ready ? 'true' : 'false'}>
      <h2 id="jongo-checks-title">Document checks</h2>
      <p><strong className={state.ready ? 'jongo-ready' : 'jongo-blocked'}>{state.ready ? 'Publish-ready checks passed' : `Not publish-ready: ${state.errors} blocking ${state.errors === 1 ? 'issue' : 'issues'}`}</strong>{state.warnings > 0 && ` · ${state.warnings} ${state.warnings === 1 ? 'note' : 'notes'} about preserved content`}</p>
      <p className="jongo-hint">Checks run in the browser against the schema; the server repeats them and decides. Publishing needs the document to be saved and pass every check.</p>
      {issues.length > 0 && <ul className="jongo-summary-list">{issues.slice(0, 20).map((issue, i) => <li key={i}><button type="button" className="jongo-link" onClick={() => jump(issue.path)}><span className={issue.severity === 'error' ? 'jongo-error' : 'jongo-warning'}>{issue.severity === 'error' ? 'Error' : 'Note'}</span> {pathLabel(issue.path)}: {issue.message}</button></li>)}{issues.length > 20 && <li>…and {issues.length - 20} more.</li>}</ul>}
    </section>
    <form noValidate onSubmit={event => { event.preventDefault(); save(); }}>
      <div inert={busy ? true : undefined} aria-busy={busy ? 'true' : undefined}>
        {schema.fields.map(field => <Field key={field.name} d={field} label={field.title ?? field.name} path={[field.name]} value={working[field.name]} onChange={next => { setWorking(setField(working, field.name, next) as ContentDocument); announce(''); }} />)}
      </div>
      <div className="jongo-savebar">
        <button id="jongo-save" className="jongo-primary" type="submit" disabled={!dirty || !!busy}>{busy === 'saving' ? 'Saving…' : 'Save draft'}</button>
        <button id="jongo-publish" type="button" onClick={publish} disabled={!canPublish} aria-describedby="jongo-publish-hint">{busy === 'publishing' ? 'Publishing…' : 'Publish'}</button>
        <button id="jongo-reset" type="button" disabled={!dirty || !!busy} onClick={() => { setWorking(record.doc); announce('Unsaved changes reset to the last saved version.'); }}>Reset changes</button>
        <button id="jongo-unpublish" type="button" onClick={unpublish} disabled={!record.published || dirty || !!busy}>Unpublish</button>
        <button id="jongo-discard" type="button" onClick={discard} disabled={record.variant !== 'draft' || !record.published || !!busy}>Discard draft</button>
      </div>
      <p id="jongo-publish-hint" className="jongo-hint">{publishHint}</p>
      <div role="status" aria-live="polite" aria-atomic="true" className="jongo-live">{message.text}{message.count % 2 ? '\u200b' : ''}</div></form>
    <details><summary>Schema information</summary><p>{schema.name} · version {schema.schemaVersion} · {schema.fields.length} registered fields · {working._id} · revision {record.nativeRev}</p></details>
  </StudioContext.Provider>
    : unavailable ? <div role="alert" className="jongo-problem jongo-problem-unavailable" data-problem={unavailable.code}><h2>{PROBLEM_TITLE[unavailable.code]}</h2><p>{unavailable.message}</p><p className="jongo-hint">The document list could not be loaded, so nothing is shown here. Local drafts are not available while a store is connected.</p><button type="button" disabled={listing} onClick={() => { void refreshList(); }}>Try again</button>{unavailable.code === 'denied' && signInHref && <p><a className="jongo-link" href={signInHref}>Sign in again</a></p>}</div>
    : problem ? <div role="alert" className={`jongo-problem jongo-problem-${problem.code}`} data-problem={problem.code}><h2>{PROBLEM_TITLE[problem.code]}</h2><p>{problem.message}</p>{selectedId && <button type="button" onClick={() => { void loadDocument(selectedId); }}>Try again</button>}{problem.code === 'denied' && signInHref && <p><a className="jongo-link" href={signInHref}>Sign in again</a></p>}</div>
    : busy === 'loading' || listing ? <p role="status">Loading…</p>
    : <p>Select a document to begin.</p>;
  return <div className="jongo-studio" data-studio-mode="store"><a className="jongo-skip" href="#jongo-editor">Skip to editor</a><header className="jongo-topbar"><a className="jongo-brand" href={brand.homeHref}>{brand.logoSrc && <img src={brand.logoSrc} alt="" />}{brand.name}<span>Studio</span></a><span>Content workspace</span>{brand.designSystemHref && <a href={brand.designSystemHref}>Design system ↗</a>}{topbarSlot && <div className="jongo-topbar-slot">{topbarSlot}</div>}</header>
    <div className="jongo-desk"><aside className="jongo-structure"><p className="jongo-eyebrow">Structure</p><h2>Content</h2><nav aria-label="Content structure">{config.schemas.map(item => <a className="jongo-nav-item" href={documentHref(item.name)} key={item.name} aria-current={type === item.name ? 'page' : undefined} onClick={event => navigate(event, item.name)}>{item.title ?? item.name}<span>›</span></a>)}</nav></aside>
      <section className="jongo-documents" aria-label="Document list"><h2>{schema?.title ?? schema?.name ?? 'Documents'}</h2><label>Search documents<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by title" /></label><div className="jongo-document-list">{visible.map(item => <a className="jongo-nav-item" href={documentHref(item.type, item.id)} key={item.id} aria-current={selectedId === item.id ? 'page' : undefined} onClick={event => navigate(event, item.type, item.id)}><strong>{item.title}</strong><small>{stateOf(item)} · {item.type}</small></a>)}</div>{!visible.length && !listing && !unavailable && <p>{summaries.some(item => item.type === type) ? 'No matching documents.' : 'No documents of this type are stored yet.'}</p>}</section>
      <main id="jongo-editor" className="jongo-editor" tabIndex={-1}>{notice && <p className="jongo-notice" role="note">{notice}</p>}{editorBody}</main>
    </div></div>;
}
