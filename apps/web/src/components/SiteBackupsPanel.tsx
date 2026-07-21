"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export type SiteBackupRow = {
  id: string;
  startedAt: string;
  completedAt: string | null;
  status: string;
  trigger: string;
  label: string | null;
  posts: number | null;
  pages: number | null;
  plugins: number | null;
  comments: number | null;
  wpVersion: string | null;
  restorable: boolean;
  error: string | null;
};

type Props = {
  siteId: string;
  backups: SiteBackupRow[];
  canManage: boolean;
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric"
  });
}

function formatTimeUtc(iso: string): string {
  return `${new Date(iso).toISOString().slice(11, 16)} UTC`;
}

function relativeAge(iso: string): string {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function Metric({ value, label }: { value: number | string | null; label: string }) {
  const empty = value === null || value === undefined || value === "";
  return (
    <div className="bk-metric">
      <p className={`bk-metric__value${empty ? " bk-metric__value--muted" : ""}`}>
        {empty ? "—" : value}
      </p>
      <p className="bk-metric__label">{label}</p>
    </div>
  );
}

export default function SiteBackupsPanel({ siteId, backups, canManage }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Close the actions menu on outside click / Escape.
  useEffect(() => {
    if (!openMenu) return;
    function onClick(event: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        setOpenMenu(null);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpenMenu(null);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [openMenu]);

  // While a backup is running, poll so the row fills in without a manual refresh.
  const hasRunning = backups.some((b) => b.status === "running");
  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(() => router.refresh(), 15000);
    return () => clearInterval(timer);
  }, [hasRunning, router]);

  function report(text: string, error = false) {
    setMessage(text);
    setIsError(error);
  }

  async function createBackup() {
    setBusy(true);
    report("");
    try {
      const res = await fetch(`/api/sites/${encodeURIComponent(siteId)}/backups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 202) {
        report(data.message ?? data.error ?? "Backup could not be started.", true);
      } else {
        report(data.message ?? "Backup started.");
        router.refresh();
      }
    } catch {
      report("Network error — could not reach the backup API.", true);
    } finally {
      setBusy(false);
    }
  }

  async function restore(backupId: string, when: string) {
    const confirmed = window.confirm(
      `Restore the backup from ${when}?\n\n` +
        "This OVERWRITES the live site's files and database, and the site will be briefly offline.\n\n" +
        "A safety snapshot of the current state is taken first, so this can be rolled back."
    );
    if (!confirmed) return;

    setBusy(true);
    setOpenMenu(null);
    report("");
    try {
      const res = await fetch(
        `/api/sites/${encodeURIComponent(siteId)}/backups/${encodeURIComponent(backupId)}/restore`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirm: "RESTORE" })
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 202) {
        report(data.message ?? data.error ?? "Restore could not be started.", true);
      } else {
        report(data.message ?? "Restore started.");
        router.refresh();
      }
    } catch {
      report("Network error — could not reach the restore API.", true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="card" ref={panelRef}>
      <div className="bk-head">
        <div>
          <h3 className="card-title" style={{ marginTop: 0 }}>Backups</h3>
          <p className="card-muted" style={{ margin: 0 }}>
            Full site snapshots — files and database — stored offsite in Backblaze.
          </p>
        </div>
        {canManage ? (
          <button
            type="button"
            className="bk-btn bk-btn--primary"
            onClick={createBackup}
            disabled={busy}
            title="Create a backup now"
          >
            {busy ? "Working…" : "+  Back up now"}
          </button>
        ) : null}
      </div>

      {message ? (
        <p className={`bk-note${isError ? " bk-note--error" : ""}`} role="status">
          {message}
        </p>
      ) : null}

      {backups.length === 0 ? (
        <div className="bk-empty">
          <p className="bk-empty__title">No backups yet</p>
          <p className="bk-empty__hint">
            {canManage
              ? "Create the first snapshot — it captures files and the database together, offsite."
              : "Backups will appear here once your administrator creates one."}
          </p>
        </div>
      ) : (
        <div className="bk-list">
          {backups.map((b) => {
            const running = b.status === "running";
            const failed = b.status === "failed";
            const when = formatDate(b.startedAt);

            return (
              <div className="bk-row" key={b.id}>
                <div className="bk-when">
                  <p className="bk-when__date">{when}</p>
                  <p className="bk-when__time">
                    {formatTimeUtc(b.startedAt)} · {relativeAge(b.startedAt)}
                  </p>
                  {b.trigger === "manual" ? <span className="bk-tag">Manual</span> : null}
                  {b.label ? (
                    <p className="bk-when__time" style={{ marginTop: "0.25rem" }}>{b.label}</p>
                  ) : null}
                </div>

                {running ? (
                  <div className="bk-metrics">
                    <span className="status-chip unknown bk-pulse">Backing up…</span>
                    <span className="bk-when__time">Capturing files and database to Backblaze</span>
                  </div>
                ) : failed ? (
                  <div className="bk-metrics">
                    <span className="status-chip error">Failed</span>
                    <span className="bk-when__time">{b.error ?? "This backup did not complete."}</span>
                  </div>
                ) : (
                  <div className="bk-metrics">
                    <Metric value={b.posts} label="Posts" />
                    <Metric value={b.pages} label="Pages" />
                    <Metric value={b.plugins} label="Plugins" />
                    <Metric value={b.comments} label="Comments" />
                    <Metric value={b.wpVersion} label="WP Version" />
                  </div>
                )}

                <div className="bk-actions">
                  {canManage && b.restorable ? (
                    <>
                      <button
                        type="button"
                        className="bk-btn bk-btn--icon"
                        onClick={() => setOpenMenu(openMenu === b.id ? null : b.id)}
                        disabled={busy}
                        aria-haspopup="menu"
                        aria-expanded={openMenu === b.id}
                        aria-label={`Actions for backup from ${when}`}
                      >
                        ⋯
                      </button>
                      {openMenu === b.id ? (
                        <div className="bk-menu" role="menu">
                          <button
                            type="button"
                            className="bk-btn bk-btn--danger"
                            onClick={() => restore(b.id, when)}
                            disabled={busy}
                            role="menuitem"
                          >
                            Restore this backup
                          </button>
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </article>
  );
}
