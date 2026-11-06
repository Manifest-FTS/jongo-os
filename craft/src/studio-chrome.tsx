"use client";
/** Shared chrome of the document panel: tiny icon set, action menu, avatar chip, timestamps, issue chip, History and Inspect dialogs. */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Dialog } from './shell.js';
import type { TypeDefinition } from './schema.js';
import type { Issue, Path } from './validate.js';
import { formatStamp, historyLabel, initialsOf, safeAvatarUrl, settle, type StudioActor, type StudioHistoryEntry, type StudioResult } from './studio-store.js';

export type IconName = 'save' | 'publish' | 'unpublish' | 'duplicate' | 'delete' | 'history' | 'inspect' | 'copy' | 'more' | 'reset';
const ICONS: Record<IconName, ReactNode> = {
  save: <path d="M3 2.5h8l2.5 2.5v8a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5ZM5 2.5v3.5h5V2.5M5 13.5v-4h6v4" />,
  publish: <path d="M8 11.5V3.5M4.75 6.75 8 3.5l3.25 3.25M3 13.5h10" />,
  unpublish: <path d="M8 3v8M4.75 7.75 8 11l3.25-3.25M3 13.5h10" />,
  duplicate: <path d="M6 5.5h6.5v8H6zM3.5 10.5v-8h7" />,
  delete: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M6.75 7v4M9.25 7v4" />,
  history: <><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.25l2 1.25" /></>,
  inspect: <path d="M5.5 5 2.5 8l3 3M10.5 5l3 3-3 3" />,
  copy: <path d="M5.5 3h5v2h-5zM4 4h-.5a.5.5 0 0 0-.5.5v8.5a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5V4.5a.5.5 0 0 0-.5-.5H12" />,
  more: <><circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none" /><circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" /><circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none" /></>,
  reset: <path d="M3.5 8a4.5 4.5 0 1 0 1.4-3.25M3.5 3v2.5H6" />
};
/** Decorative: every control that uses an icon also has visible text or an `aria-label`. */
export function Icon({ name }: { name: IconName }) {
  return <svg className="jongo-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">{ICONS[name]}</svg>;
}

export type MenuEntry = { id?: string; label: string; icon?: IconName; onSelect: () => void; disabled?: boolean; danger?: boolean; separatorBefore?: boolean; title?: string };

/** Popover menu button: arrow keys, Home/End, Escape (returns focus to the trigger), Tab and outside click close it. */
export function ActionMenu({ id, label, entries, placement = 'down' }: { id: string; label: string; entries: readonly MenuEntry[]; placement?: 'up' | 'down' }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const start = useRef<'first' | 'last'>('first');
  const menuId = `${id}-menu`;
  const enabled = () => Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
  const close = useCallback((restore: boolean) => { setOpen(false); if (restore) trigger.current?.focus(); }, []);
  useEffect(() => {
    if (!open) return;
    const items = enabled();
    (start.current === 'last' ? items[items.length - 1] : items[0] ?? menu.current)?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => { if (!wrap.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  if (!entries.length) return null;
  const openWith = (where: 'first' | 'last') => { start.current = where; setOpen(true); };
  const onTriggerKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openWith(event.key === 'ArrowDown' ? 'first' : 'last'); }
  };
  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = enabled(), at = items.indexOf(document.activeElement as HTMLButtonElement);
    const move = (to: number) => { event.preventDefault(); items[(to + items.length) % items.length]?.focus(); };
    if (event.key === 'ArrowDown') move(at + 1);
    else if (event.key === 'ArrowUp') move(at < 0 ? -1 : at - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(-1);
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === 'Tab') { event.preventDefault(); close(true); }
  };
  return <div className="jongo-menu-wrap" ref={wrap} data-placement={placement}>
    <button ref={trigger} id={id} type="button" className="jongo-icon-button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} aria-controls={menuId}
      onClick={() => { if (open) close(false); else openWith('first'); }} onKeyDown={onTriggerKey}><Icon name="more" /></button>
    <div ref={menu} id={menuId} role="menu" tabIndex={-1} aria-labelledby={id} className="jongo-menu" hidden={!open} onKeyDown={onMenuKey}>
      {entries.map((entry, index) => <div key={entry.label} role="none" className="jongo-menu-row">
        {entry.separatorBefore && index > 0 && <div role="separator" className="jongo-menu-sep" />}
        <button type="button" role="menuitem" tabIndex={-1} id={entry.id} disabled={entry.disabled} title={entry.title} className={`jongo-menu-item${entry.danger ? ' jongo-menu-danger' : ''}`}
          onClick={() => { close(true); entry.onSelect(); }}>{entry.icon && <Icon name={entry.icon} />}<span>{entry.label}</span></button>
      </div>)}
    </div>
  </div>;
}

/** Initials chip, or the picture only for a plain https URL. Decorative: the person is named in the adjacent text. */
export function Avatar({ by }: { by?: StudioActor }) {
  if (!by) return null;
  const src = safeAvatarUrl(by.avatarUrl);
  return <span className="jongo-avatar" aria-hidden="true">{src ? <img src={src} alt="" width={24} height={24} referrerPolicy="no-referrer" loading="lazy" /> : initialsOf(by.name) || '·'}</span>;
}

/** Who is signed in, for the top bar: avatar (picture only for plain https), name or email, and a role badge. `elevated` marks platform-level access. */
export type StudioPerson = { name?: string; email?: string; avatarUrl?: string };
export function StudioIdentity({ person, roleLabel, elevated = false }: { person: StudioPerson; roleLabel: string; elevated?: boolean }) {
  const label = person.name || person.email || 'Signed in';
  return <span className="jongo-identity" data-studio-identity="true">
    <Avatar by={{ id: 'viewer', name: label, avatarUrl: person.avatarUrl }} />
    <span className="jongo-identity-name" data-identity-name="true">{label}</span>
    <span className={`jongo-role-badge${elevated ? ' jongo-role-elevated' : ''}`} data-role-badge="true">{roleLabel}</span>
  </span>;
}

/** UTC (labelled) until mounted, then the viewer's zone: the first client render matches the server HTML. */
export function Stamp({ iso }: { iso: string }) {
  const [local, setLocal] = useState(false);
  useEffect(() => setLocal(true), []);
  const text = formatStamp(iso, local ? undefined : 'UTC');
  return text ? <time dateTime={iso}>{text}{local ? '' : ' UTC'}</time> : null;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
/** Live validation summary: jumps to the first blocking issue (or first note). */
export function IssueChip({ issues, onJump }: { issues: readonly Issue[]; onJump: (path: Path) => void }) {
  const errors = issues.filter(issue => issue.severity === 'error');
  const first = errors[0] ?? issues[0];
  if (!first) return <span className="jongo-issue-chip jongo-issue-ok" data-issue-chip="clear">No issues</span>;
  return <button type="button" className={`jongo-issue-chip ${errors.length ? 'jongo-issue-error' : 'jongo-issue-note'}`} data-issue-chip={errors.length ? 'error' : 'note'} title="Go to the first one" onClick={() => onJump(first.path)}>
    {errors.length ? plural(errors.length, 'issue', 'issues') : plural(issues.length, 'note', 'notes')}</button>;
}

export async function copyText(text: string): Promise<boolean> {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch { /* fall back to the legacy path */ }
  const previous = document.activeElement as HTMLElement | null;
  try {
    const area = document.createElement('textarea');
    area.value = text; area.setAttribute('readonly', ''); area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    (previous?.closest('dialog') ?? document.body).appendChild(area);
    area.select();
    const done = document.execCommand('copy');
    area.remove(); previous?.focus();
    return done;
  } catch { return false; }
}

export type HistoryLoader = () => Promise<StudioResult<{ entries: StudioHistoryEntry[] }>>;
export function HistoryDialog({ load, onClose }: { load: HistoryLoader; onClose: () => void }) {
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'ok'; entries: StudioHistoryEntry[] } | { kind: 'error'; message: string }>({ kind: 'loading' });
  useEffect(() => {
    let current = true;
    void settle(load).then(result => { if (current) setState(result.ok ? { kind: 'ok', entries: result.entries } : { kind: 'error', message: result.message }); });
    return () => { current = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one read per opening
  }, []);
  return <Dialog title="Document history" onClose={onClose}>
    {state.kind === 'loading' && <p role="status">Loading history…</p>}
    {state.kind === 'error' && <p role="alert" className="jongo-error">{state.message}</p>}
    {state.kind === 'ok' && (state.entries.length
      ? <ol className="jongo-history" aria-label="Revisions, newest first">{state.entries.map((entry, i) => <li key={i}><span className="jongo-history-action">{historyLabel(entry.action)}</span><span className="jongo-history-meta"><Avatar by={entry.by} /><Stamp iso={entry.at} />{entry.by?.name ? ` · ${entry.by.name}` : ''}</span></li>)}</ol>
      : <p>No recorded activity yet.</p>)}
    <p className="jongo-hint">Read-only list of changes to this document. Earlier versions cannot be restored from here.</p>
  </Dialog>;
}

export function InspectDialog({ doc, schema, revision, onClose }: { doc: Record<string, unknown>; schema: TypeDefinition; revision?: string; onClose: () => void }) {
  const [status, setStatus] = useState('');
  const json = JSON.stringify(doc, null, 2);
  return <Dialog title="Inspect document" onClose={onClose}>
    <dl className="jongo-inspect-info">
      <div><dt>Type</dt><dd>{schema.name}</dd></div>
      <div><dt>Schema version</dt><dd>{schema.schemaVersion}</dd></div>
      <div><dt>Fields</dt><dd>{schema.fields.length} registered</dd></div>
      <div><dt>Document ID</dt><dd>{String(doc._id ?? '')}</dd></div>
      {revision && <div><dt>Revision</dt><dd>{revision}</dd></div>}
    </dl>
    <pre tabIndex={0} aria-label="Document JSON (read-only)" className="jongo-inspect-json">{json}</pre>
    <div className="jongo-actions"><button type="button" onClick={() => { void copyText(json).then(done => setStatus(done ? 'Document JSON copied to the clipboard.' : 'Could not copy automatically. Select the JSON above and copy it.')); }}><Icon name="copy" />Copy JSON</button></div>
    <p role="status" className="jongo-hint">{status}</p>
  </Dialog>;
}

/** Header tools menu: History for everyone; Inspect and Copy document (raw JSON, schema details) only when `debug`. Plus the dialogs they open. */
export function DocumentTools({ doc, schema, revision, loadHistory, announce, debug = false }: { doc: Record<string, unknown>; schema: TypeDefinition; revision?: string; loadHistory?: HistoryLoader; announce: (text: string) => void; debug?: boolean }) {
  const [dialog, setDialog] = useState<'history' | 'inspect' | null>(null);
  const entries: MenuEntry[] = [
    ...(loadHistory ? [{ id: 'jongo-history', label: 'History', icon: 'history' as const, onSelect: () => setDialog('history') }] : []),
    ...(debug ? [
      { id: 'jongo-inspect', label: 'Inspect', icon: 'inspect' as const, onSelect: () => setDialog('inspect') },
      { id: 'jongo-copy-document', label: 'Copy document', icon: 'copy' as const, onSelect: () => { void copyText(JSON.stringify(doc, null, 2)).then(done => announce(done ? 'Document JSON copied to the clipboard.' : 'Could not copy to the clipboard.')); } }
    ] : [])
  ];
  return <>
    <ActionMenu id="jongo-tools" label="Document tools" entries={entries} placement="down" />
    {dialog === 'history' && loadHistory && <HistoryDialog load={loadHistory} onClose={() => setDialog(null)} />}
    {dialog === 'inspect' && <InspectDialog doc={doc} schema={schema} revision={revision} onClose={() => setDialog(null)} />}
  </>;
}

export function EditorHeader({ eyebrow, title, pills, tools }: { eyebrow: string; title: string; pills: ReactNode; tools: ReactNode }) {
  return <header className="jongo-doc-header" aria-label="Document header">
    <div className="jongo-doc-heading"><p className="jongo-eyebrow">{eyebrow}</p><h1>{title}</h1></div>
    <div className="jongo-doc-pills">{pills}</div>
    <div className="jongo-doc-tools">{tools}</div>
  </header>;
}
export function EditorFooter({ status, actions }: { status: ReactNode; actions: ReactNode }) {
  return <footer className="jongo-doc-footer">
    <div className="jongo-footer-status">{status}</div>
    <div className="jongo-footer-actions" role="group" aria-label="Document actions">{actions}</div>
  </footer>;
}
