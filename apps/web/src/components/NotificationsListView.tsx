"use client";

import { useEffect, useState } from "react";

type NotificationRow = {
  id: string;
  type: string;
  title: string;
  message: string;
  readAt: string | null;
  createdAt: string;
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

const TYPE_LABELS: Record<string, string> = {
  system_backup: "Backup",
  suspension: "Account",
  maintenance: "Maintenance",
  general: "Announcement"
};

export default function NotificationsListView() {
  const [filter, setFilter] = useState<"unread" | "all">("all");
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [emailNotificationsEnabled, setEmailNotificationsEnabled] = useState(true);
  const [backupAlertsEnabled, setBackupAlertsEnabled] = useState(true);
  const [savingPrefs, setSavingPrefs] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/notifications?filter=${filter}&limit=100`, { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (!cancelled) setError((data as { error?: string }).error ?? "Could not load notifications");
          return;
        }
        if (!cancelled) setRows((data as { notifications?: NotificationRow[] }).notifications ?? []);
      } catch {
        if (!cancelled) setError("Could not load notifications");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [filter]);

  useEffect(() => {
    let cancelled = false;
    async function loadPrefs() {
      try {
        const res = await fetch("/api/notifications/preferences", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || cancelled) return;
        setEmailNotificationsEnabled(Boolean((data as any).emailNotificationsEnabled));
        setBackupAlertsEnabled(Boolean((data as any).backupAlertsEnabled));
      } catch {
        // Defaults (both true) stand.
      }
    }
    void loadPrefs();
    return () => {
      cancelled = true;
    };
  }, []);

  async function savePrefs(next: { emailNotificationsEnabled?: boolean; backupAlertsEnabled?: boolean }) {
    setSavingPrefs(true);
    try {
      const res = await fetch("/api/notifications/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next)
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setEmailNotificationsEnabled(Boolean((data as any).emailNotificationsEnabled));
        setBackupAlertsEnabled(Boolean((data as any).backupAlertsEnabled));
      }
    } finally {
      setSavingPrefs(false);
    }
  }

  async function markRead(id: string) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, readAt: new Date().toISOString() } : r)));
    await fetch(`/api/notifications/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "read" })
    }).catch(() => {});
  }

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <article className="card">
        <h3 className="card-title">Email preferences</h3>
        <div style={{ display: "grid", gap: "0.6rem", marginTop: "0.5rem" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <input
              type="checkbox"
              checked={emailNotificationsEnabled}
              disabled={savingPrefs}
              onChange={(e) => void savePrefs({ emailNotificationsEnabled: e.target.checked })}
            />
            Email notifications
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <input
              type="checkbox"
              checked={backupAlertsEnabled}
              disabled={savingPrefs}
              onChange={(e) => void savePrefs({ backupAlertsEnabled: e.target.checked })}
            />
            Backup alert emails
          </label>
        </div>
      </article>

      <article className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 className="card-title" style={{ margin: 0 }}>Notifications</h3>
          <div className="tab-rail" role="tablist" aria-label="Filter notifications">
            <button type="button" className={`tab-link${filter === "unread" ? " is-active" : ""}`} onClick={() => setFilter("unread")}>
              Unread
            </button>
            <button type="button" className={`tab-link${filter === "all" ? " is-active" : ""}`} onClick={() => setFilter("all")}>
              All
            </button>
          </div>
        </div>

        {loading ? <p className="card-muted" style={{ marginTop: "0.85rem" }}>Loading…</p> : null}
        {error ? <p className="form-error" style={{ marginTop: "0.85rem" }}>{error}</p> : null}

        {!loading && !error && rows.length === 0 ? (
          <p className="card-muted" style={{ marginTop: "0.85rem" }}>
            {filter === "unread" ? "No unread notifications." : "No notifications yet."}
          </p>
        ) : null}

        <div style={{ display: "grid", gap: "0.6rem", marginTop: "0.9rem" }}>
          {rows.map((row) => (
            <div key={row.id} style={{ padding: "0.8rem 0.9rem", border: "1px solid var(--border)", borderRadius: "12px", background: row.readAt ? "transparent" : "var(--surface)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "0.6rem", alignItems: "flex-start" }}>
                <div>
                  <span className="tag" style={{ marginRight: "0.5rem" }}>{TYPE_LABELS[row.type] ?? row.type}</span>
                  <strong>{row.title}</strong>
                </div>
                <span className="card-muted" style={{ fontSize: "0.8rem", whiteSpace: "nowrap" }}>{formatDate(row.createdAt)}</span>
              </div>
              <p style={{ margin: "0.4rem 0 0", color: "var(--muted)" }}>{row.message}</p>
              {!row.readAt ? (
                <button type="button" className="btn" style={{ marginTop: "0.5rem" }} onClick={() => void markRead(row.id)}>
                  Mark as read
                </button>
              ) : null}
            </div>
          ))}
        </div>
      </article>
    </div>
  );
}
