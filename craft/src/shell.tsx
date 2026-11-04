"use client";
import { useEffect, useId, useRef, type ReactNode, type ButtonHTMLAttributes } from 'react';
import type { TypeDefinition } from './schema.js';

export type CraftIdentity = { id: string; label: string; role: string };
/** Content-only document descriptors, portable with Jongo's CMS schema. No operational entitlements. */
export type ContentSchema = TypeDefinition;
export type CraftContext<T> = { identity: CraftIdentity; adapter: T };
export type CraftView<T> = { id: string; title: string; href?: string; roles: readonly string[]; render: (context: CraftContext<T>) => ReactNode };
export type CraftPlugin<T> = { id: string; title: string; schemas: readonly ContentSchema[]; views: readonly CraftView<T>[] };

export function Button({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`craft-button ${className}`} {...props} />;
}
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'green' | 'amber' }) {
  return <span className={`craft-badge craft-badge-${tone}`}>{children}</span>;
}
export function Card({ children, title }: { children: ReactNode; title?: string }) {
  return <section className="craft-card">{title && <h3>{title}</h3>}{children}</section>;
}
/** Automatic activation with roving focus. Only the active panel mounts its content. */
export function Tabs({ label, items, value, onChange, children }: {
  label: string; items: readonly { id: string; label: string }[]; value: string;
  onChange: (id: string) => void; children: ReactNode;
}) {
  const id = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const active = items.some(item => item.id === value) ? value : items[0]?.id;
  return <div className="craft-tabs">
    <div role="tablist" aria-label={label} aria-orientation="horizontal" className="craft-tablist">
      {items.map((item, index) => <button type="button" className="craft-button" key={item.id} ref={element => { refs.current[index] = element; }}
        role="tab" id={`${id}-tab-${item.id}`} aria-controls={`${id}-panel-${item.id}`}
        aria-selected={active === item.id} tabIndex={active === item.id ? 0 : -1}
        onClick={() => onChange(item.id)} onKeyDown={event => {
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
            : event.key === 'ArrowRight' ? (index + 1) % items.length
            : event.key === 'ArrowLeft' ? (index + items.length - 1) % items.length : null;
          if (next === null) return;
          event.preventDefault(); onChange(items[next].id); refs.current[next]?.focus();
          refs.current[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }}>{item.label}</button>)}
    </div>
    {items.map(item => <div key={item.id} role="tabpanel" id={`${id}-panel-${item.id}`}
      aria-labelledby={`${id}-tab-${item.id}`} tabIndex={0} hidden={active !== item.id}
      className="craft-tabpanel">{active === item.id ? children : null}</div>)}
  </div>;
}
/** Native modal supplies focus containment, inert background, Escape and focus restoration. */
export function Dialog({ title, children, onClose, variant = 'modal' }: { title: string; children: ReactNode; onClose: () => void; variant?: 'modal' | 'drawer' }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current!;
    dialog.showModal();
    return () => { dialog.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} tabIndex={-1} className={`craft-dialog${variant === 'drawer' ? ' craft-drawer' : ''}`} aria-modal="true" aria-labelledby={titleId}
    onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
      // Native modality makes the background inert. Explicit wrapping also prevents Tab
      // escaping into browser chrome, and accounts for collapsed terms/disabled controls.
      if (event.key === 'Tab') {
        const dialog = ref.current!;
        const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex]:not([tabindex="-1"])')).filter(element => element.getClientRects().length && !element.hidden);
        const first = controls[0], last = controls.at(-1), active = document.activeElement;
        if (!first) { event.preventDefault(); dialog.focus(); }
        else if (event.shiftKey && (active === first || active === dialog)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (active === last || !dialog.contains(active))) { event.preventDefault(); first.focus(); }
      }
    }}
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="craft-toolbar"><h2 id={titleId}>{title}</h2><Button aria-label="Close dialog" onClick={onClose}>✕</Button></div>
    {children}
  </dialog>;
}
/** UI role filtering only. Future server adapters must independently authorize every read/write. */
export function CraftShell<T>({ plugin, context, activeView, onNavigate, controls, brand, clientNavigation = false }: {
  plugin: CraftPlugin<T>; context: CraftContext<T>; activeView: string;
  onNavigate: (id: string) => void; controls?: ReactNode; clientNavigation?: boolean;
  brand?: { name: string; tagline?: string; homeHref: string; sidebarNote?: ReactNode; footer?: ReactNode };
}) {
  const allowed = plugin.views.filter(view => view.roles.includes(context.identity.role));
  const view = allowed.find(item => item.id === activeView) ?? allowed[0];
  return <div className="craft-root">
    <a className="craft-skip" href="#craft-content">Skip to workspace</a>
    <div className="craft-frame">
      <aside className="craft-sidebar"><a className="craft-wordmark" href={brand?.homeHref ?? '#craft-content'}>{brand?.name ?? plugin.title}{brand?.tagline && <span>{brand.tagline}</span>}</a>
        <p className="craft-overline">{plugin.title}</p>
        <nav aria-label="Platform views">{allowed.map(item => item.href ? <a className="craft-button" key={item.id} href={item.href} onClick={event => { if (clientNavigation && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); onNavigate(item.id); } }} aria-current={view?.id === item.id ? 'page' : undefined}>{item.title}<span aria-hidden="true">↗</span></a> : <Button key={item.id} aria-current={view?.id === item.id ? 'page' : undefined} onClick={() => onNavigate(item.id)}>{item.title}<span aria-hidden="true">↗</span></Button>)}</nav>
        {brand?.sidebarNote && <div className="craft-sidebar-note">{brand.sidebarNote}</div>}
      </aside>
      <div className="craft-workspace"><header className="craft-header"><div><span className="craft-overline">{plugin.title}</span><p>{context.identity.label} <Badge>{context.identity.role}</Badge></p></div>{controls}</header>
        <main id="craft-content" className="craft-content" tabIndex={-1}>{view?.render(context) ?? <p>No views available.</p>}</main>
        {brand?.footer && <div className="craft-bottom-note">{brand.footer}</div>}
      </div>
    </div>
  </div>;
}