"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import CreateOrganizationForm from "@/components/CreateOrganizationForm";
import type { WorkspaceOption, WorkspacePage } from "@/lib/workspace-switcher";
import styles from "./WorkspaceSwitcher.module.css";

export type WorkspaceSwitcherProps = {
  initialOptions: WorkspaceOption[];
  hasMore?: boolean;
  nextCursor?: string | null;
  /** Server-resolved option when the current route is outside the initial page. */
  activeWorkspace?: WorkspaceOption | null;
};

export function workspaceForPath(pathname: string, options: WorkspaceOption[]): WorkspaceOption | null {
  const segment = /^\/clients\/([^/]+)(?:\/|$)/.exec(pathname)?.[1];
  if (!segment) return null;
  let key: string;
  try { key = decodeURIComponent(segment); } catch { return null; }
  return options.find((option) => option.id === key) ?? options.find((option) => option.slug === key) ?? null;
}

function isWorkspacePage(value: unknown): value is WorkspacePage {
  if (!value || typeof value !== "object") return false;
  const page = value as WorkspacePage;
  return Array.isArray(page.items) && page.items.length <= 100 && typeof page.hasMore === "boolean" &&
    (page.hasMore ? typeof page.nextCursor === "string" && !!page.nextCursor : page.nextCursor === null) &&
    page.items.every((item) => item && typeof item.id === "string" && !!item.id &&
      typeof item.name === "string" && typeof item.slug === "string" &&
      (item.planLabel === null || ["Starter", "Pro", "Studio", "Scale"].includes(item.planLabel)));
}

export default function WorkspaceSwitcher({ initialOptions, hasMore = false, nextCursor = null, activeWorkspace = null }: WorkspaceSwitcherProps) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState<WorkspacePage>({ items: initialOptions.slice(0, 100), hasMore, nextCursor });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = workspaceForPath(pathname, [...(activeWorkspace ? [activeWorkspace] : []), ...initialOptions, ...page.items]);

  function modalOpen() { return !!root.current?.querySelector("dialog[open]"); }
  function close(refocus = false) {
    // The creation drawer is a native modal inside this persistently mounted panel.
    // Never hide its ancestor or steal its focus while it is open.
    if (modalOpen()) return;
    request.current?.abort();
    request.current = null;
    setBusy(false);
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }

  async function load(value: string, cursor: string | null = null) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(null);
    if (!cursor) setPage({ items: [], hasMore: false, nextCursor: null });
    try {
      const params = new URLSearchParams({ search: value, limit: "100" });
      if (cursor) params.set("cursor", cursor);
      const response = await fetch(`/api/workspaces?${params}`, {
        credentials: "same-origin", cache: "no-store", signal: controller.signal
      });
      const data: unknown = await response.json();
      if (controller.signal.aborted || request.current !== controller) return;
      if (!response.ok || !isWorkspacePage(data)) throw new Error();
      setPage((previous) => ({ ...data, items: cursor
        ? [...previous.items, ...data.items.filter((item) => !previous.items.some((old) => old.id === item.id))]
        : data.items }));
    } catch {
      if (!controller.signal.aborted && request.current === controller) setError("Unable to load workspaces. Try again.");
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  }

  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);
  useEffect(() => {
    if (!open) return;
    searchInput.current?.focus();
    const doc = root.current?.ownerDocument;
    function outside(event: Event) {
      if (!modalOpen() && event.target instanceof Node && !root.current?.contains(event.target)) close();
    }
    doc?.addEventListener("pointerdown", outside);
    doc?.addEventListener("focusin", outside);
    return () => {
      doc?.removeEventListener("pointerdown", outside);
      doc?.removeEventListener("focusin", outside);
    };
    // Listeners read mutable refs; they only exist for an open disclosure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => { close(); }, [pathname]); // Navigation is not a global workspace filter.

  return (
    <div ref={root} className={styles.root} onKeyDown={(event) => {
      if (event.key === "Escape" && open && !modalOpen()) { event.preventDefault(); event.stopPropagation(); close(true); }
    }}>
      <button ref={trigger} type="button" className={styles.trigger} aria-expanded={open} aria-controls={`${id}-panel`}
        onClick={() => {
          if (open) { close(true); return; }
          setOpen(true);
          setSearch("");
          void load("");
        }}>
        <span className={styles.name}>{active?.name ?? "All workspaces"}</span>
        {active?.planLabel && <span className={styles.badge}>{active.planLabel}</span>}
        <span aria-hidden="true">▾</span>
      </button>
      {/* Keep the form mounted: closing the disclosure must not orphan a modal or its request. */}
      <section id={`${id}-panel`} aria-label="Switch workspace" className={styles.panel} hidden={!open}>
        <label htmlFor={`${id}-search`} className={styles.label}>Find a workspace</label>
        <input ref={searchInput} id={`${id}-search`} type="search" className={styles.search} value={search}
          maxLength={100} autoComplete="off" onChange={(event) => {
            const value = event.target.value.slice(0, 100);
            setSearch(value);
            void load(value);
          }} />
        <div className={styles.results} aria-busy={busy}>
          <ul className={styles.list}>
            <li><Link href="/clients" className={styles.option} onClick={() => close()}>All workspaces</Link></li>
            {page.items.map((option) => (
              <li key={option.id}><Link href={`/clients/${encodeURIComponent(option.id)}`} className={styles.option}
                aria-current={active?.id === option.id ? "page" : undefined} onClick={() => close()}>
                <span className={styles.name}>{option.name}</span>
                {option.planLabel && <span className={styles.badge}>{option.planLabel}</span>}
              </Link></li>
            ))}
          </ul>
          {!busy && page.items.length === 0 && !error && <p className={styles.message}>No workspaces found.</p>}
        </div>
        <p role="status" className={styles.message}>{busy ? "Loading workspaces…" : ""}</p>
        {error && <div role="alert" className={styles.message}>{error} <button type="button" className={styles.next}
          onClick={() => void load(search, page.nextCursor)}>Retry</button></div>}
        {page.hasMore && page.nextCursor && <button type="button" className={styles.next} disabled={busy}
          onClick={() => void load(search, page.nextCursor)}>Load more workspaces</button>}
        <div className={styles.create}>
          <CreateOrganizationForm triggerLabel="+ Create Team / Workspace" onCreated={(organization) => {
            // The child has queued its dialog close; keep it mounted for native cleanup.
            request.current?.abort();
            request.current = null;
            setBusy(false);
            setOpen(false);
            router.push(`/clients/${encodeURIComponent(organization.id)}`);
          }} />
        </div>
      </section>
    </div>
  );
}