"use client";

import { useState } from "react";
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

function formatWhen(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }),
    time: `${d.toISOString().slice(11, 16)} UTC`
  };
}

function Metric({ value, unit }: { value: number | null; unit: string }) {
  return (
    <div style={{ minWidth: "5.5rem" }}>
      <div style={{ fontSize: "1.15rem", fontWeight: 600, lineHeight: 1.1 }}>{value ?? "—"}</div>
      <div style={{ fontSize: "0.75rem", color: "var(--muted)" }}>{unit}</div>
    </div>
  );
}

export default function SiteBackupsPanel({ siteId, backups, canManage }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);

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

  async function restore(backupId: string) {
    const confirmed = window.confirm(
      "Restore this backup?\n\nThis OVERWRITES the live site's files and database, and the site will be briefly offline. " +
        "A safety snapshot of the current state is taken first so this can be rolled back."
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
    <article className="card">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" }}>
        <div>
          <h2 style={{ margin: 0 }}>Backups</h2>
          <p style={{ margin: "0.25rem 0 0", fontSize: "0.84rem", color: "var(--muted)" }}>
            Full site snapshots — files and database — stored offsite in Backblaze.
          </p>
        </div>
        {canManage ? (
          <button
            type="button"
            className="button button-secondary"
            onClick={createBackup}
            disabled={busy}
            aria-label="Create backup"
            title="Create backup now"
          >
            {busy ? "Working…" : "+ Back up now"}
          </button>
        ) : null}
      </div>

      {message ? (
        <p
          style={{
            margin: "0.75rem 0 0",
            fontSize: "0.8rem",
            color: isError ? "var(--danger, #b00020)" : "var(--muted)"
          }}
        >
          {message}
        </p>
      ) : null}

      {backups.length === 0 ? (
        <p style={{ margin: "1rem 0 0", fontSize: "0.86rem", color: "var(--muted)" }}>
          No backups yet.{canManage ? " Use “Back up now” to create the first one." : ""}
        </p>
      ) : (
        <div style={{ marginTop: "1rem", display: "flex", flexDirection: "column" }}>
          {backups.map((b) => {
            const when = formatWhen(b.startedAt);
            const running = b.status === "running";
            const failed = b.status === "failed";
            return (
              <div
                key={b.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "1rem",
                  flexWrap: "wrap",
                  padding: "0.85rem 0",
                  borderTop: "1px solid var(--border)"
                }}
              >
                <div style={{ minWidth: "10rem" }}>
                  <div style={{ fontWeight: 600 }}>{when.date}</div>
                  <div style={{ fontSize: "0.78rem", color: "var(--muted)" }}>
                    {when.time}
                    {b.trigger === "manual" ? " · manual" : ""}
                  </div>
                  {b.label ? (
                    <div style={{ fontSize: "0.78rem", color: "var(--muted)" }}>{b.label}</div>
                  ) : null}
                </div>

                {running ? (
                  <span className="status-chip unknown">Backing up…</span>
                ) : failed ? (
                  <span className="status-chip degraded" title={b.error ?? undefined}>
                    Failed
                  </span>
                ) : (
                  <>
                    <Metric value={b.posts} unit="Posts" />
                    <Metric value={b.pages} unit="Pages" />
                    <Metric value={b.plugins} unit="Plugins" />
                    <Metric value={b.comments} unit="Comments" />
                    <div style={{ minWidth: "6rem" }}>
                      <div style={{ fontSize: "1.05rem", fontWeight: 600, lineHeight: 1.1 }}>
                        {b.wpVersion ?? "—"}
                      </div>
                      <div style={{ fontSize: "0.75rem", color: "var(--muted)" }}>WP Version</div>
                    </div>
                  </>
                )}

                {canManage && b.restorable ? (
                  <div style={{ position: "relative" }}>
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => setOpenMenu(openMenu === b.id ? null : b.id)}
                      disabled={busy}
                      aria-label="Backup actions"
                    >
                      ⋯
                    </button>
                    {openMenu === b.id ? (
                      <div
                        style={{
                          position: "absolute",
                          right: 0,
                          top: "110%",
                          zIndex: 10,
                          background: "var(--surface, #fff)",
                          border: "1px solid var(--border)",
                          borderRadius: "8px",
                          padding: "0.35rem",
                          minWidth: "12rem",
                          boxShadow: "0 6px 18px rgba(0,0,0,0.12)"
                        }}
                      >
                        <button
                          type="button"
                          className="button button-secondary"
                          style={{ width: "100%" }}
                          onClick={() => restore(b.id)}
                          disabled={busy}
                        >
                          Restore this backup
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div style={{ width: "3rem" }} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </article>
  );
}
