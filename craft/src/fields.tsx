"use client";
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Dialog } from './shell.js';
import { IMAGE_ASSET_TYPE, type Descriptor } from './schema.js';
import { appendItem, canAddItem, documentTitle, isObject, memberFor, memberTitle, moveItem, newImage, newItem, newReference, removeItem, replaceItem, resolveReference, searchReferences, setField, slugify, type Candidate } from './content-ops.js';
import { PortableTextEditor } from './portable-text-editor.js';
import { Hint, Issues, LabelText, describedBy, fieldId, hasErrors, useIssues, useStudio } from './studio-context.js';
import type { Path } from './validate.js';

type Props<D extends Descriptor = Descriptor> = { d: D; label: string; path: Path; value: unknown; onChange: (value: unknown) => void; member?: boolean };
type ArrayDescriptor = Extract<Descriptor, { type: 'array' }>;
const thumbUrl = (doc: { url?: unknown }) => typeof doc.url === 'string' && (/^\/(?!\/)/.test(doc.url) || /^https?:\/\//.test(doc.url)) ? doc.url : undefined;

export function Field(props: Props) {
  const { d } = props;
  switch (d.type) {
    case 'object': return <ObjectField {...props} d={d} />;
    case 'array': return <ArrayField {...props} d={d} />;
    case 'reference': return <ReferenceField {...props} d={d} />;
    case 'image': return <ImageField {...props} d={d} />;
    case 'portableText': return <PortableTextField {...props} />;
    default: return <PrimitiveField {...props} />;
  }
}

function PrimitiveField({ d, label, path, value, onChange, member }: Props) {
  const api = useStudio(), id = fieldId(api.docId, path), issues = useIssues(path);
  const text = d.type === 'slug' ? (isObject(value) && typeof value.current === 'string' ? value.current : '') : typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  const counter = (d.type === 'string' || d.type === 'text') && d.maxLength !== undefined ? `${text.length}/${d.maxLength} characters` : '';
  const hint = [d.description, d.type === 'datetime' ? 'Time is stored in UTC.' : '', counter].filter(Boolean).join(' · ');
  const aria = { id, 'aria-invalid': hasErrors(issues) ? true as const : undefined, 'aria-describedby': describedBy(id, !!hint, issues), 'aria-required': d.required || member ? true as const : undefined };
  const input = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => event.target.value;
  let control;
  switch (d.type) {
    case 'boolean':
      return <div className="jongo-field jongo-check"><label><input {...aria} type="checkbox" checked={value === true} onChange={event => onChange(event.target.checked)} /><span><LabelText title={label} required={d.required} isPrivate={d.private} /></span></label><Hint id={id}>{hint}</Hint><Issues id={id} issues={issues} /></div>;
    case 'text': control = <textarea {...aria} rows={5} value={text} onChange={event => onChange(input(event) || undefined)} />; break;
    case 'enum': control = <select {...aria} value={typeof value === 'string' ? value : ''} onChange={event => onChange(input(event) || undefined)}><option value="">Choose an option</option>{d.options.map(option => <option key={option} value={option}>{option}</option>)}{typeof value === 'string' && value && !d.options.includes(value) && <option value={value}>{value} (not registered)</option>}</select>; break;
    case 'number': control = <input {...aria} type="number" step={d.integer ? 1 : 'any'} min={d.min} max={d.max} value={typeof value === 'number' ? value : text} onChange={event => onChange(event.target.value === '' ? undefined : Number(event.target.value))} />; break;
    case 'date': control = <input {...aria} type="date" value={text} onChange={event => onChange(input(event) || undefined)} />; break;
    case 'datetime': control = <input {...aria} type="datetime-local" value={/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) ? text.slice(0, 16) : text} onChange={event => onChange(event.target.value ? `${event.target.value}:00.000Z` : undefined)} />; break;
    case 'slug': {
      const source = d.source ? api.values[d.source] : undefined;
      control = <div className="jongo-inline-control"><input {...aria} type="text" autoComplete="off" spellCheck={false} value={text} onChange={event => onChange(event.target.value ? { _type: 'slug', current: event.target.value } : undefined)} />
        {d.source && <button type="button" disabled={typeof source !== 'string' || !slugify(source)} onClick={() => { onChange({ _type: 'slug', current: slugify(String(source)) }); api.announce('Slug generated from the source field.'); }}>Generate from {d.source}</button>}</div>;
      break;
    }
    case 'url': control = <input {...aria} type="text" inputMode="url" autoComplete="off" value={text} onChange={event => onChange(input(event) || undefined)} />; break;
    default: control = <input {...aria} type="text" value={text} onChange={event => onChange(input(event) || undefined)} />;
  }
  return <div className="jongo-field"><label htmlFor={id}><LabelText title={label} required={d.required || member} isPrivate={d.private} /></label><Hint id={id}>{hint}</Hint>{control}<Issues id={id} issues={issues} /></div>;
}

function ObjectField({ d, label, path, value, onChange }: Props<Extract<Descriptor, { type: 'object' }>>) {
  const api = useStudio(), id = fieldId(api.docId, path), issues = useIssues(path);
  const object = isObject(value) ? value : {};
  return <fieldset id={id} tabIndex={-1} className="jongo-group" aria-describedby={describedBy(id, !!d.description, issues)}>
    <legend><LabelText title={label} required={d.required} isPrivate={d.private} /></legend>
    <Hint id={id}>{d.description}</Hint>
    {d.fields.map(field => <Field key={field.name} d={field} label={field.title ?? field.name} path={[...path, field.name]} value={object[field.name]} onChange={next => onChange(setField(object, field.name, next))} />)}
    <Issues id={id} issues={issues} />
  </fieldset>;
}

function PickerDialog({ title, to, kind, onPick, onClose }: { title: string; to: readonly string[]; kind: 'document' | 'image'; onPick: (candidate: Candidate) => void; onClose: () => void }) {
  const api = useStudio(), [query, setQuery] = useState(''), search = useRef<HTMLInputElement>(null);
  const results = searchReferences(api.index, to, query, api.schemas);
  // The native dialog is not open until its own effect runs, so focus the search box afterwards.
  useEffect(() => { const timer = setTimeout(() => search.current?.focus(), 0); return () => clearTimeout(timer); }, []);
  return <Dialog title={title} onClose={onClose}>
    <label>Search {kind === 'image' ? 'images' : 'documents'}<input ref={search} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Title, type or ID" /></label>
    <p className="jongo-hint" role="status">{results.length} {results.length === 1 ? 'result' : 'results'} · {kind === 'image' ? 'Images come from the supplied asset library. Uploading is not available.' : `Allowed types: ${to.join(', ')}`}</p>
    {results.length ? <ul className="jongo-picker">{results.map(candidate => { const thumb = kind === 'image' ? thumbUrl(candidate.entry.doc) : undefined;
      return <li key={candidate.id}><button type="button" aria-label={`Select ${candidate.title} (${candidate.type})`} onClick={() => onPick(candidate)}>{thumb && <img src={thumb} alt="" width={44} height={44} loading="lazy" />}<span><strong>{candidate.title}</strong><small>{candidate.type} · {candidate.id}</small></span></button></li>; })}</ul>
      : <p>No matching {kind === 'image' ? 'images' : 'documents'}.</p>}
  </Dialog>;
}

function Target({ value, to, kind }: { value: unknown; to: readonly string[]; kind: 'document' | 'image' }) {
  const api = useStudio();
  const found = resolveReference(api.index, value, to);
  if (found.status === 'empty') return <p className="jongo-ref-target jongo-hint">No {kind} selected.</p>;
  if (!found.entry) return <p className="jongo-ref-target jongo-missing">Unresolved reference: {String((value as { _ref?: unknown })._ref)}</p>;
  const title = documentTitle(found.entry.doc, api.schemas.get(found.entry._type));
  const thumb = kind === 'image' ? thumbUrl(found.entry.doc) : undefined;
  return <p className="jongo-ref-target">{thumb && <img src={thumb} alt="" width={44} height={44} />}<span><strong>{title}</strong><small>{found.entry._type}{found.status === 'type' ? ' · not an allowed type' : ''}</small></span></p>;
}

function ReferenceField({ d, label, path, value, onChange, member }: Props<Extract<Descriptor, { type: 'reference' }>>) {
  const api = useStudio(), id = fieldId(api.docId, path), issues = useIssues(path), [open, setOpen] = useState(false);
  const chosen = isObject(value) && typeof value._ref === 'string' && value._ref !== '';
  return <fieldset className="jongo-group" aria-describedby={describedBy(id, !!d.description, issues)}>
    <legend><LabelText title={label} required={d.required} isPrivate={d.private} /></legend>
    <Hint id={id}>{d.description ?? `Allowed types: ${d.to.join(', ')}${d.weak ? ' · weak reference' : ''}`}</Hint>
    <Target value={value} to={d.to} kind="document" />
    <div className="jongo-actions"><button type="button" id={id} aria-haspopup="dialog" onClick={() => setOpen(true)}>{chosen ? 'Change' : 'Choose'} {label}</button>
      {chosen && !member && <button type="button" onClick={() => { onChange(undefined); api.announce(`${label} cleared.`); api.focus(id); }}>Clear {label}</button>}</div>
    <Issues id={id} issues={issues} />
    {open && <PickerDialog title={`Choose ${label}`} to={d.to} kind="document" onClose={() => setOpen(false)} onPick={candidate => {
      onChange({ ...(isObject(value) ? value : {}), ...newReference(candidate.id, d.weak), ...(isObject(value) && value._key ? { _key: value._key } : {}) });
      setOpen(false); api.announce(`${label} set to ${candidate.title}.`);
    }} />}
  </fieldset>;
}

function ImageField({ d, label, path, value, onChange, member }: Props<Extract<Descriptor, { type: 'image' }>>) {
  const api = useStudio(), id = fieldId(api.docId, path), issues = useIssues(path), assetIssues = useIssues([...path, 'asset']), altIssues = useIssues([...path, 'alt']), [open, setOpen] = useState(false);
  const image = isObject(value) ? value : {}, chosen = isObject(image.asset) && typeof image.asset._ref === 'string' && image.asset._ref !== '';
  const text = (name: string) => typeof image[name] === 'string' ? image[name] as string : '';
  const all = [...issues, ...assetIssues];
  return <fieldset id={id} tabIndex={-1} className="jongo-group" aria-describedby={describedBy(id, !!d.description, all)}>
    <legend><LabelText title={label} required={d.required} isPrivate={d.private} /></legend>
    <Hint id={id}>{d.description}</Hint>
    <Target value={image.asset} to={[IMAGE_ASSET_TYPE]} kind="image" />
    <div className="jongo-actions"><button type="button" id={`${id}.pick`} aria-haspopup="dialog" onClick={() => setOpen(true)}>{chosen ? 'Change' : 'Choose'} {label}</button>
      {!member && (chosen || Object.keys(image).length > 0) && <button type="button" onClick={() => { onChange(undefined); api.announce(`${label} removed.`); api.focus(`${id}.pick`); }}>Remove {label}</button>}</div>
    {(['alt', 'caption'] as const).map(name => { const fid = `${id}.${name}`, found = name === 'alt' ? altIssues : [];
      return <div className="jongo-field" key={name}><label htmlFor={fid}><LabelText title={name === 'alt' ? 'Alternative text' : 'Caption'} required={name === 'alt' && d.altRequired} /></label>
        <input id={fid} type="text" value={text(name)} aria-invalid={hasErrors(found) ? true : undefined} aria-describedby={found.length ? `${fid}-issues` : undefined}
          onChange={event => onChange(setField(image, name, event.target.value || undefined))} /><Issues id={fid} issues={found} /></div>; })}
    <Issues id={id} issues={all} />
    {open && <PickerDialog title={`Choose ${label}`} to={[IMAGE_ASSET_TYPE]} kind="image" onClose={() => setOpen(false)} onPick={candidate => {
      onChange({ ...image, _type: 'image', asset: { _type: 'reference', _ref: candidate.id } });
      setOpen(false); api.announce(`${label} set to ${candidate.title}.`);
    }} />}
  </fieldset>;
}

function PortableTextField({ d, label, path, value, onChange }: Props) {
  const api = useStudio(), id = fieldId(api.docId, path), issues = useIssues(path);
  return <fieldset className="jongo-group" aria-describedby={describedBy(id, !!d.description, issues)}>
    <legend><LabelText title={label} required={d.required} isPrivate={d.private} /></legend>
    <Hint id={id}>{d.description ?? 'Block content. Unsupported blocks, marks and annotations are preserved unchanged.'}</Hint>
    <PortableTextEditor id={id} label={label} path={path} value={value} onChange={onChange} />
    <Issues id={id} issues={issues} />
  </fieldset>;
}

function ArrayField({ d, label, path, value, onChange }: Props<ArrayDescriptor>) {
  const api = useStudio(), id = fieldId(api.docId, path), issues = useIssues(path), [picking, setPicking] = useState<Descriptor | null>(null);
  const list: unknown[] = Array.isArray(value) ? value : [];
  const set = (next: unknown[]) => onChange(next.length ? next : undefined);
  const itemId = (index: number) => fieldId(api.docId, [...path, index]);
  const nameOf = (index: number) => { const member = memberFor(d, list[index]); return `${member ? memberTitle(member) : 'Item'} ${index + 1}`; };
  const atMax = !canAddItem(d, list.length);
  const added = (title: string) => { api.announce(`${title} added. ${list.length + 1} ${list.length === 0 ? 'item' : 'items'}.`); api.focus(itemId(list.length)); };
  const move = (index: number, to: number) => {
    set(moveItem(list, index, to));
    api.announce(`${nameOf(index)} moved ${to > index ? 'down' : 'up'} to position ${to + 1} of ${list.length}.`);
    api.focus(`${itemId(to)}.${to > index ? (to === list.length - 1 ? 'up' : 'down') : (to === 0 ? 'down' : 'up')}`);
  };
  const remove = (index: number) => {
    set(removeItem(list, index));
    api.announce(`${nameOf(index)} removed. ${list.length - 1} ${list.length === 2 ? 'item' : 'items'} remaining.`);
    api.focus(list.length > 1 ? itemId(Math.min(index, list.length - 2)) : `${id}.add.0`);
  };
  const add = (member: Descriptor) => {
    if (member.type === 'reference' || member.type === 'image') { setPicking(member); return; }
    set(appendItem(list, newItem(member, api.makeKey))); added(memberTitle(member));
  };
  const pick = (member: Descriptor, candidate: Candidate) => {
    const key = api.makeKey();
    set(appendItem(list, member.type === 'image' ? newImage(candidate.id, key) : newReference(candidate.id, member.type === 'reference' ? member.weak : false, key)));
    setPicking(null); added(candidate.title);
  };
  const bounds = d.minItems !== undefined || d.maxItems !== undefined ? ` · ${d.minItems ?? 0} to ${d.maxItems ?? 'any number'} items` : '';
  return <fieldset id={id} tabIndex={-1} className="jongo-group jongo-array" aria-describedby={describedBy(id, true, issues)}>
    <legend><LabelText title={label} required={d.required} isPrivate={d.private} /></legend>
    <Hint id={id}>{[d.description, `${list.length} ${list.length === 1 ? 'item' : 'items'}${bounds}`].filter(Boolean).join(' · ')}</Hint>
    {list.length === 0 ? <p className="jongo-hint">No items yet.</p> : <ol className="jongo-array-list">{list.map((item, index) => {
      const member = memberFor(d, item), key = isObject(item) && typeof item._key === 'string' ? item._key : `i${index}`, title = nameOf(index);
      return <li key={key} className="jongo-array-item">
        {member ? <Field d={member} label={title} path={[...path, index]} value={item} member onChange={next => set(replaceItem(list, index, next === undefined ? '' : next))} />
          : <fieldset id={itemId(index)} tabIndex={-1} className="jongo-group jongo-pt-preserved"><legend>{title} · Preserved item</legend><pre>{JSON.stringify(item, null, 2).slice(0, 2000)}</pre></fieldset>}
        <div className="jongo-actions" role="group" aria-label={`Actions for ${title}`}>
          <button type="button" id={`${itemId(index)}.up`} disabled={index === 0} aria-label={`Move ${title} up`} onClick={() => move(index, index - 1)}>↑</button>
          <button type="button" id={`${itemId(index)}.down`} disabled={index === list.length - 1} aria-label={`Move ${title} down`} onClick={() => move(index, index + 1)}>↓</button>
          <button type="button" aria-label={`Remove ${title}`} onClick={() => remove(index)}>Remove</button>
        </div></li>;
    })}</ol>}
    <div className="jongo-actions">{d.of.map((member, index) => <button type="button" key={index} id={`${id}.add.${index}`} disabled={atMax} aria-haspopup={member.type === 'reference' || member.type === 'image' ? 'dialog' : undefined} onClick={() => add(member)}>Add {memberTitle(member)}</button>)}</div>
    {atMax && <p className="jongo-hint">Maximum of {d.maxItems} items reached.</p>}
    <Issues id={id} issues={issues} />
    {picking && (picking.type === 'reference' || picking.type === 'image') && <PickerDialog title={`Add ${memberTitle(picking)}`} to={picking.type === 'image' ? [IMAGE_ASSET_TYPE] : picking.to} kind={picking.type === 'image' ? 'image' : 'document'} onClose={() => setPicking(null)} onPick={candidate => pick(picking, candidate)} />}
  </fieldset>;
}
