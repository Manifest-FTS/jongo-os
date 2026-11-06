"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { StarIcon } from "@/components/JongoIcons";
import { ADD_APP_EVENT } from "@/components/CreateSiteForm";
import { GitBranchMark, GithubMark, GlobeMark, WordPressMark } from "@/components/SourceIcons";

export type ClientAppRow = {
  id: string;
  href: string;
  name: string;
  kind: "wordpress" | "database" | "service" | "app";
  status: "healthy" | "degraded" | "error" | "unknown";
  deploying: boolean;
  domain: string | null;
  repo: string | null;
  provider: "github" | "gitlab" | "bitbucket" | "gitea" | "other" | null;
  branch: string | null;
  lastDeployAt: string | null;
  lastDeployFailed: boolean;
  /** Its Jongo app was deleted but the resource still runs on the server. */
  leftover?: { siteId: string; deletedAt: string } | null;
};

type Filter = "all" | "live" | "attention" | "unknown" | "leftover";
type View = "list" | "grid";

const STATUS: Record<ClientAppRow["status"], { label: string; dot: string }> = {
  healthy: { label: "Live", dot: "status-dot--healthy" },
  degraded: { label: "Needs attention", dot: "status-dot--degraded" },
  error: { label: "Down", dot: "status-dot--error" },
  unknown: { label: "Status unknown", dot: "" }
};

function ago(iso: string | null): string | null {
  if (!iso) return null;
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(iso).toLocaleDateString();
}

function AppIcon({ row }: { row: ClientAppRow }) {
  if (row.kind === "wordpress") return <span className="app-row__icon"><WordPressMark size={20} /></span>;
  if (row.provider === "github") return <span className="app-row__icon"><GithubMark size={18} /></span>;
  if (row.repo) return <span className="app-row__icon"><GitBranchMark size={18} /></span>;
  return <span className="app-row__icon" aria-hidden="true">{row.name.slice(0, 1).toUpperCase()}</span>;
}

function StatusLine({ row }: { row: ClientAppRow }) {
  if (row.leftover) {
    return (
      <span className="app-row__status" title={`Deleted in Jongo ${new Date(row.leftover.deletedAt).toLocaleDateString()}; the server still runs it.`}>
        <span className="status-dot status-dot--degraded" aria-hidden="true" />
        Deleted in Jongo, still on the server
      </span>
    );
  }
  if (row.deploying) {
    return (
      <span className="app-row__status">
        <span className="status-dot status-dot--deploying" aria-hidden="true" />
        Deploying…
      </span>
    );
  }
  const status = STATUS[row.status];
  return (
    <span className="app-row__status">
      <span className={`status-dot ${status.dot}`} aria-hidden="true" />
      {status.label}
    </span>
  );
}

function Source({ row }: { row: ClientAppRow }) {
  if (!row.repo) return <span className="app-row__meta">{row.kind === "wordpress" ? "WordPress" : "—"}</span>;
  return (
    <span className="app-row__meta" title={`${row.repo}${row.branch ? ` @ ${row.branch}` : ""}`}>
      <GitBranchMark size={14} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{row.repo}</span>
      {row.branch ? <span style={{ opacity: 0.75 }}>· {row.branch}</span> : null}
    </span>
  );
}

function readView(): View {
  try {
    return window.localStorage.getItem("jongo.clientApps.view") === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

/** Restore the Jongo app, or delete the resource from the server. */
function LeftoverActions({ row, canManage }: { row: ClientAppRow; canManage: boolean }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<"restore" | "destroy" | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  if (!row.leftover || !canManage) return null;

  async function act(action: "restore" | "destroy") {
    setBusy(action);
    setMessage(null);
    const res = await fetch(`/api/leftovers/${encodeURIComponent(row.leftover!.siteId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action })
    }).catch(() => null);
    const data = res ? await res.json().catch(() => null) : null;
    setBusy(null);
    setConfirming(false);
    setMessage({ ok: Boolean(data?.ok), text: data?.message ?? "That didn't work. Try again." });
    if (data?.ok) router.refresh();
  }

  return (
    <div className="leftover-actions" onClick={(event) => event.stopPropagation()}>
      {confirming ? (
        <>
          <span className="leftover-actions__ask">Delete it from the server? This can&apos;t be undone.</span>
          <button type="button" className="btn btn-danger px-2.5 py-1 text-[12.5px]" disabled={busy !== null} onClick={() => act("destroy")}>
            {busy === "destroy" ? "Deleting…" : "Delete"}
          </button>
          <button type="button" className="btn btn-secondary px-2.5 py-1 text-[12.5px]" disabled={busy !== null} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </>
      ) : (
        <>
          <button type="button" className="btn btn-secondary px-2.5 py-1 text-[12.5px]" disabled={busy !== null} onClick={() => act("restore")}>
            {busy === "restore" ? "Restoring…" : "Restore"}
          </button>
          <button type="button" className="btn btn-secondary px-2.5 py-1 text-[12.5px]" disabled={busy !== null} onClick={() => setConfirming(true)}>
            Delete from server
          </button>
        </>
      )}
      {message ? (
        <span role="status" className={message.ok ? "leftover-actions__ok" : "auth-error leftover-actions__err"}>{message.text}</span>
      ) : null}
    </div>
  );
}

export default function ClientAppsView({
  rows,
  userId,
  canCreate,
  canManage = false,
  initialFilter = "all"
}: {
  rows: ClientAppRow[];
  userId?: string;
  canCreate: boolean;
  canManage?: boolean;
  initialFilter?: "all" | "leftover";
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>(initialFilter);
  const [view, setView] = useState<View>("list");
  const [favorites, setFavorites] = useState<Set<string>>(new Set());

  useEffect(() => setView(readView()), []);
  useEffect(() => {
    if (!userId) return;
    fetch("/api/user/favorites/apps", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const ids: string[] = Array.isArray(data?.appIds) ? data.appIds : [];
        setFavorites(new Set(ids));
      })
      .catch(() => undefined);
  }, [userId]);

  const chooseView = (next: View) => {
    setView(next);
    try {
      window.localStorage.setItem("jongo.clientApps.view", next);
    } catch {
      // per-browser convenience only
    }
  };

  async function toggleFavorite(id: string) {
    const on = !favorites.has(id);
    setFavorites((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
    const res = await fetch("/api/user/favorites/apps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: id, favorited: on })
    }).catch(() => null);
    if (!res?.ok) {
      setFavorites((current) => {
        const next = new Set(current);
        if (on) next.delete(id);
        else next.add(id);
        return next;
      });
    }
  }

  const counts = useMemo(
    () => ({
      all: rows.length,
      live: rows.filter((row) => row.status === "healthy").length,
      attention: rows.filter((row) => row.status === "degraded" || row.status === "error").length,
      unknown: rows.filter((row) => row.status === "unknown" && !row.leftover).length,
      leftover: rows.filter((row) => row.leftover).length
    }),
    [rows]
  );

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows
      .filter((row) =>
        filter === "all" ||
        (filter === "live" && row.status === "healthy") ||
        (filter === "attention" && (row.status === "degraded" || row.status === "error")) ||
        (filter === "unknown" && row.status === "unknown" && !row.leftover) ||
        (filter === "leftover" && Boolean(row.leftover))
      )
      .filter((row) => !needle || [row.name, row.domain, row.repo].some((value) => value?.toLowerCase().includes(needle)))
      .sort((a, b) => {
        const fa = favorites.has(a.id) ? 1 : 0;
        const fb = favorites.has(b.id) ? 1 : 0;
        if (fa !== fb) return fb - fa;
        const ta = a.lastDeployAt ? new Date(a.lastDeployAt).getTime() : 0;
        const tb = b.lastDeployAt ? new Date(b.lastDeployAt).getTime() : 0;
        if (ta !== tb) return tb - ta;
        return a.name.localeCompare(b.name);
      });
  }, [rows, filter, query, favorites]);

  if (rows.length === 0) {
    const open = (mode?: string) => window.dispatchEvent(new CustomEvent(ADD_APP_EVENT, { detail: { mode } }));
    return (
      <div className="apps-empty">
        <div style={{ display: "grid", gap: "0.35rem" }}>
          <h3 style={{ margin: 0, fontSize: "1.1rem" }}>No apps yet</h3>
          <p className="card-muted" style={{ margin: 0 }}>
            {canCreate ? "Deploy a project from Git or start a WordPress site. Hosting, the address and the first deploy are set up for you." : "This client has no apps yet."}
          </p>
        </div>
        {canCreate ? (
          <div className="apps-empty__choices">
            {[
              { mode: "private", title: "Import from GitHub", help: "Every push deploys", icon: <GithubMark /> },
              { mode: "deploykey", title: "GitLab, Bitbucket & other Git", help: "Private repo with a deploy key", icon: <GitBranchMark /> },
              { mode: "public", title: "Public repository", help: "Paste any public repo URL", icon: <GlobeMark /> },
              { mode: "create", title: "WordPress site", help: "With its own database", icon: <WordPressMark /> }
            ].map((choice) => (
              <button key={choice.mode} type="button" className="source-card" onClick={() => open(choice.mode)}>
                <span className="source-card__icon">{choice.icon}</span>
                <span className="source-card__text">
                  <span className="source-card__title">{choice.title}</span>
                  <span className="source-card__help">{choice.help}</span>
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  const star = (row: ClientAppRow) =>
    userId ? (
      <button
        type="button"
        className="app-row__star"
        aria-pressed={favorites.has(row.id)}
        aria-label={favorites.has(row.id) ? `Unstar ${row.name}` : `Star ${row.name}`}
        onClick={(event) => {
          event.preventDefault();
          void toggleFavorite(row.id);
        }}
      >
        <StarIcon className="btn-icon" filled={favorites.has(row.id)} />
      </button>
    ) : null;

  return (
    <div style={{ display: "grid", gap: "0.85rem" }}>
      <div className="apps-toolbar">
        <label className="apps-search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ color: "var(--muted)" }}>
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search apps, addresses or repositories" aria-label="Search apps" />
        </label>
        <div className="apps-chips" role="group" aria-label="Filter by status">
          {([
            ["all", "All"],
            ["live", "Live"],
            ["attention", "Needs attention"],
            ["unknown", "Unknown"],
            ["leftover", "Leftovers"]
          ] as const)
            .filter(([value]) => value === "all" || counts[value] > 0)
            .map(([value, label]) => (
              <button key={value} type="button" className="apps-chip" aria-pressed={filter === value} onClick={() => setFilter(value)}>
                {label}
                <span className="apps-chip__count">{counts[value]}</span>
              </button>
            ))}
        </div>
        <div className="apps-view-toggle" role="group" aria-label="Layout">
          <button type="button" aria-pressed={view === "list"} onClick={() => chooseView("list")}>List</button>
          <button type="button" aria-pressed={view === "grid"} onClick={() => chooseView("grid")}>Grid</button>
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="card-muted" style={{ margin: "1rem 0", textAlign: "center" }}>No apps match. Clear the search or choose another filter.</p>
      ) : view === "list" ? (
        <div className="apps-list" role="list">
          {shown.map((row) => (
            <div key={row.id} className={`app-row${row.leftover ? " app-row--leftover" : ""}`} role="listitem">
              {row.leftover ? null : <Link href={row.href} className="app-row__link" aria-label={`Open ${row.name}`} />}
              <AppIcon row={row} />
              <div className="app-row__main">
                <span className="app-row__name">{row.name}</span>
                <span className="app-row__domain">
                  {row.domain ? (
                    <a href={`https://${row.domain}`} target="_blank" rel="noopener noreferrer">{row.domain}</a>
                  ) : (
                    "No address yet"
                  )}
                </span>
              </div>
              <Source row={row} />
              <div style={{ display: "grid", gap: "0.15rem" }}>
                <StatusLine row={row} />
                {row.lastDeployAt ? (
                  <span className="app-row__when">
                    {row.lastDeployFailed ? "Last deploy failed " : "Deployed "}
                    {ago(row.lastDeployAt)}
                  </span>
                ) : null}
              </div>
              {row.leftover ? <span /> : star(row)}
              {row.leftover ? <LeftoverActions row={row} canManage={canManage} /> : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="apps-grid" role="list">
          {shown.map((row) => (
            <div key={row.id} className={`app-card${row.leftover ? " app-row--leftover" : ""}`} role="listitem">
              {row.leftover ? null : <Link href={row.href} className="app-row__link" aria-label={`Open ${row.name}`} />}
              <div className="app-card__top">
                <AppIcon row={row} />
                <div className="app-row__main" style={{ flex: 1 }}>
                  <span className="app-row__name">{row.name}</span>
                  <span className="app-row__domain">
                    {row.domain ? <a href={`https://${row.domain}`} target="_blank" rel="noopener noreferrer">{row.domain}</a> : "No address yet"}
                  </span>
                </div>
                {row.leftover ? null : star(row)}
              </div>
              <Source row={row} />
              <div className="app-card__foot">
                <StatusLine row={row} />
                <span className="app-row__when">{row.lastDeployAt ? `${row.lastDeployFailed ? "Failed" : "Deployed"} ${ago(row.lastDeployAt)}` : ""}</span>
              </div>
              {row.leftover ? <LeftoverActions row={row} canManage={canManage} /> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
