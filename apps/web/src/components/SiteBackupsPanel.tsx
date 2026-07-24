"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ConfirmDialog from "@/components/ConfirmDialog";
import { ToastStack, useToasts } from "@/components/Toasts";
import { describeBackupError } from "@/lib/backup-messages";

export type SiteBackupRow = {
  id: string;
  startedAt: string;
  completedAt: string | null;
  status: string;
  trigger: string;
  label: string | null;
  resourceType: string | null;
  volumeCount: number | null;
  databaseCount: number | null;
  sizeBytes: number | null;
  posts: number | null;
  pages: number | null;
  plugins: number | null;
  comments: number | null;
  wpVersion: string | null;
  restorable: boolean;
  error: string | null;
  restoreStatus: string | null;
  restoreError: string | null;
};

function formatBytes(n: number | null): string | null {
  if (n === null || !Number.isFinite(n) || n <= 0) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

type Props = {
  siteId: string;
  backups: SiteBackupRow[];
  canManage: boolean;
  /** False for non-WordPress resources, which cannot be full-site backed up. */
  supported?: boolean;
  page: number;
  pageSize: number;
  total: number;
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

export default function SiteBackupsPanel({
  siteId,
  backups,
  canManage,
  supported = true,
  page,
  pageSize,
  total
}: Props) {
  const router = useRouter();
  const { toasts, push, dismiss } = useToasts();
  const [busy, setBusy] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [pendingRestore, setPendingRestore] = useState<{ id: string; when: string } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createComment, setCreateComment] = useState("");
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

  // Poll while anything is in flight so rows fill in without a manual refresh.
  const inFlight = backups.some((b) => b.status === "running" || b.restoreStatus === "running");
  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => router.refresh(), 10000);
    return () => clearInterval(timer);
  }, [inFlight, router]);

  // Announce transitions: a backup or restore that WAS running and now isn't.
  const prevRef = useRef<Map<string, { status: string; restoreStatus: string | null }>>(new Map());
  useEffect(() => {
    const prev = prevRef.current;
    for (const b of backups) {
      const before = prev.get(b.id);
      if (before) {
        if (before.status === "running" && b.status !== "running") {
          push(
            b.status === "success"
              ? { tone: "success", title: "Backup complete", text: "Files and database are saved offsite in Backblaze." }
              : {
                  tone: "error",
                  title: "Backup failed",
                  text: describeBackupError(b.error) ?? "The backup did not complete.",
                  ttl: 0
                }
          );
        }
        if (before.restoreStatus === "running" && b.restoreStatus && b.restoreStatus !== "running") {
          push(
            b.restoreStatus === "success"
              ? { tone: "success", title: "Restore complete", text: "The site has been rolled back and is running again." }
              : {
                  tone: "error",
                  title: "Restore failed",
                  text: describeBackupError(b.restoreError) ?? "The restore did not complete.",
                  ttl: 0
                }
          );
        }
      }
    }
    prevRef.current = new Map(backups.map((b) => [b.id, { status: b.status, restoreStatus: b.restoreStatus }]));
  }, [backups, push]);

  async function createBackup() {
    setBusy(true);
    try {
      const res = await fetch(`/api/sites/${encodeURIComponent(siteId)}/backups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: createComment.trim() || undefined })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 202) {
        push({ tone: "error", title: "Couldn't start backup", text: data.message ?? data.error ?? "Please try again.", ttl: 0 });
      } else {
        push({ tone: "info", title: "Backup started", text: "Capturing files and database — this page updates automatically." });
        setCreateOpen(false);
        setCreateComment("");
        router.refresh();
      }
    } catch {
      push({ tone: "error", title: "Network error", text: "Could not reach the backup API.", ttl: 0 });
    } finally {
      setBusy(false);
    }
  }

  async function restore(backupId: string) {
    setBusy(true);
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
        push({ tone: "error", title: "Couldn't start restore", text: data.message ?? data.error ?? "Please try again.", ttl: 0 });
      } else {
        push({
          tone: "info",
          title: "Restore started",
          text: "The site is briefly offline while files and the database are put back."
        });
        router.refresh();
      }
    } catch {
      push({ tone: "error", title: "Network error", text: "Could not reach the restore API.", ttl: 0 });
    } finally {
      setBusy(false);
      setPendingRestore(null);
    }
  }

  return (
    <article className="card" ref={panelRef}>
      <div className="bk-head">
        <div>
          <h3 className="card-title" style={{ marginTop: 0, display: "flex", alignItems: "baseline", gap: "0.5rem", flexWrap: "wrap" }}>
            <span>Backups</span>
            <span
              style={{
                color: "var(--muted)",
                fontStyle: "italic",
                fontWeight: 500,
                fontSize: "0.92rem",
                fontFamily: "Georgia, 'Times New Roman', serif"
              }}
            >
              powered by
            </span>
            <img
              src="/assets/logos/logo-Backblaze.svg"
              alt="Backblaze"
              style={{ height: "1.25rem", width: "auto", transform: "translateY(1px)" }}
            />
          </h3>
          {/* <p className="card-muted" style={{ margin: 0 }}>
            Full site snapshots — files and database.
          </p> */}
        </div>
        {canManage ? (
          <button
            type="button"
            className="bk-btn bk-btn--primary"
            onClick={() => setCreateOpen(true)}
            disabled={busy}
            title="Create a new backup"
            aria-label="Create a new backup"
            style={{
              width: "2.3rem",
              height: "2.3rem",
              borderRadius: "999px",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "1.2rem",
              lineHeight: 1,
              padding: 0
            }}
          >
            +
          </button>
        ) : null}
      </div>

      {backups.length === 0 ? (
        <div className="bk-empty">
          <p className="bk-empty__title">
            {supported ? "No backups yet" : "Not available for this app"}
          </p>
          <p className="bk-empty__hint">
            {!supported
              ? "No files or database were found for this app to back up. If it should have data, its Coolify resource mapping may be out of date — re-check it in app settings."
              : canManage
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

                {b.restoreStatus === "running" ? (
                  <div className="bk-metrics">
                    <span className="status-chip unknown bk-pulse">Restoring…</span>
                    <span className="bk-when__time">Putting files and the database back — the site is briefly offline</span>
                  </div>
                ) : running ? (
                  <div className="bk-metrics">
                    <span className="status-chip unknown bk-pulse">Backing up…</span>
                    <span className="bk-when__time">Capturing files and database to Backblaze</span>
                  </div>
                ) : failed ? (
                  <div className="bk-metrics">
                    <span className="status-chip error">Failed</span>
                    <span className="bk-when__time">
                      {describeBackupError(b.error) ?? "This backup did not complete."}
                    </span>
                  </div>
                ) : b.resourceType === "wordpress" || b.posts !== null || b.wpVersion !== null ? (
                  <div className="bk-metrics">
                    <Metric value={b.posts} label="Posts" />
                    <Metric value={b.pages} label="Pages" />
                    <Metric value={b.plugins} label="Plugins" />
                    <Metric value={b.comments} label="Comments" />
                    <Metric value={b.wpVersion} label="WP Version" />
                  </div>
                ) : (
                  <div className="bk-metrics">
                    <Metric value={b.volumeCount} label={b.volumeCount === 1 ? "Volume" : "Volumes"} />
                    <Metric value={b.databaseCount} label={b.databaseCount === 1 ? "Database" : "Databases"} />
                    <Metric value={formatBytes(b.sizeBytes)} label="Size" />
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
                            onClick={() => {
                              setOpenMenu(null);
                              setPendingRestore({ id: b.id, when });
                            }}
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

          {total > pageSize ? (
            <div className="bk-pager">
              <p className="bk-pager__info">
                Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total} backups
              </p>
              <div className="bk-pager__controls">
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => router.push(`?bkPage=${page - 1}`, { scroll: false })}
                  disabled={page <= 1}
                >
                  Newer
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => router.push(`?bkPage=${page + 1}`, { scroll: false })}
                  disabled={page * pageSize >= total}
                >
                  Older
                </button>
              </div>
            </div>
          ) : null}
        </div>
      )}

      <ToastStack toasts={toasts} onDismiss={dismiss} side="left" />

      {createOpen ? (
        <div
          className="cd-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) {
              setCreateOpen(false);
            }
          }}
        >
          <div className="cd-dialog" role="dialog" aria-modal="true" aria-labelledby="bk-create-title">
            <h2 className="cd-title" id="bk-create-title">Create a new backup</h2>
            <label className="cd-label" htmlFor="bk-create-comment">Comment (optional)</label>
            <input
              id="bk-create-comment"
              className="cd-input"
              value={createComment}
              onChange={(event) => setCreateComment(event.target.value)}
              placeholder="Add context for this backup"
              maxLength={200}
              disabled={busy}
            />
            <div className="cd-actions">
              <button
                type="button"
                className="button button-secondary"
                onClick={() => {
                  setCreateOpen(false);
                  setCreateComment("");
                }}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button cd-confirm"
                onClick={() => {
                  void createBackup();
                }}
                disabled={busy}
              >
                {busy ? "Working…" : "Create backup"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={pendingRestore !== null}
        title="Restore this backup?"
        body={
          pendingRestore
            ? `This replaces the live site with the backup from ${pendingRestore.when}. Files and the database are both rolled back, and the site will be briefly offline while it happens.`
            : ""
        }
        warning="Any content created since that backup will be lost. A safety snapshot of the current state is taken first, so this can be undone."
        confirmPhrase="RESTORE"
        confirmLabel="Restore site"
        busy={busy}
        onCancel={() => setPendingRestore(null)}
        onConfirm={() => {
          if (pendingRestore) void restore(pendingRestore.id);
        }}
      />
    </article>
  );
}
