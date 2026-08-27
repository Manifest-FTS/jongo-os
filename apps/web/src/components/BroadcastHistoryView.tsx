"use client";

import { useEffect, useState } from "react";

type BroadcastRow = {
  id: string;
  templateKey: string | null;
  subject: string;
  deliveryMode: string;
  recipientScope: { scope?: string } | null;
  recipientCount: number;
  emailSentCount: number;
  emailFailedCount: number;
  createdAt: string;
  createdByUser: { email: string; fullName: string | null } | null;
};

const DELIVERY_LABELS: Record<string, string> = {
  in_app: "In-App Only",
  email: "Email Only",
  in_app_and_email: "In-App + Email"
};

const SCOPE_LABELS: Record<string, string> = {
  all: "All Clients",
  clients: "Specific Client(s)",
  apps: "Specific App(s)",
  members: "Specific Team Member(s)"
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

/** The stored subject is the template as typed, before per-recipient substitution -- {{tokens}} here are expected, not a bug. */
function hasUnresolvedPlaceholder(text: string): boolean {
  return /\{\{\s*\w+\s*\}\}/.test(text);
}

type RecipientRow = {
  userId: string;
  email: string;
  fullName: string | null;
  readAt: string | null;
  dismissedAt: string | null;
};

function RecipientDetail({ broadcastId }: { broadcastId: string }) {
  const [recipients, setRecipients] = useState<RecipientRow[] | null>(null);
  const [tracked, setTracked] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/notifications/broadcasts/${broadcastId}/recipients`, { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (!cancelled) setError((data as { error?: string }).error ?? "Could not load recipients");
          return;
        }
        if (!cancelled) {
          setRecipients((data as { recipients?: RecipientRow[] }).recipients ?? []);
          setTracked(Boolean((data as { tracked?: boolean }).tracked));
        }
      } catch {
        if (!cancelled) setError("Could not load recipients");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [broadcastId]);

  if (loading) return <p className="card-muted" style={{ margin: 0 }}>Loading recipients…</p>;
  if (error) return <p className="form-error" style={{ margin: 0 }}>{error}</p>;
  if (!tracked || !recipients) {
    return (
      <p className="card-muted" style={{ margin: 0, fontSize: "0.85rem" }}>
        This broadcast was Email Only, so no in-app read receipts exist for it. Choose "In-App" or "In-App + Branded
        Email" to get per-recipient open tracking.
      </p>
    );
  }

  const openedCount = recipients.filter((r) => r.readAt).length;

  return (
    <div style={{ display: "grid", gap: "0.5rem" }}>
      <p className="card-muted" style={{ margin: 0, fontSize: "0.85rem" }}>
        {openedCount} of {recipients.length} opened in Jongo.
      </p>
      <div style={{ display: "grid", gap: "0.3rem" }}>
        {recipients.map((r) => (
          <div
            key={r.userId}
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: "0.6rem",
              padding: "0.4rem 0.6rem",
              borderRadius: "8px",
              background: "var(--surface)"
            }}
          >
            <span>{r.fullName || r.email}</span>
            <span className="card-muted" style={{ fontSize: "0.78rem", whiteSpace: "nowrap" }}>
              {r.readAt ? `Opened ${formatDate(r.readAt)}` : "Not opened yet"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function BroadcastHistoryView() {
  const [rows, setRows] = useState<BroadcastRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/notifications/broadcasts", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (!cancelled) setError((data as { error?: string }).error ?? "Could not load broadcast history");
          return;
        }
        if (!cancelled) setRows((data as { broadcasts?: BroadcastRow[] }).broadcasts ?? []);
      } catch {
        if (!cancelled) setError("Could not load broadcast history");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <article className="card">
      <h3 className="card-title">Activity History</h3>
      {loading ? <p className="card-muted" style={{ marginTop: "0.85rem" }}>Loading…</p> : null}
      {error ? <p className="form-error" style={{ marginTop: "0.85rem" }}>{error}</p> : null}
      {!loading && !error && rows.length === 0 ? (
        <p className="card-muted" style={{ marginTop: "0.85rem" }}>No broadcasts sent yet.</p>
      ) : null}

      <div style={{ display: "grid", gap: "0.6rem", marginTop: "0.9rem" }}>
        {rows.map((row) => {
          const expanded = expandedId === row.id;
          return (
            <div key={row.id} style={{ padding: "0.8rem 0.9rem", border: "1px solid var(--border)", borderRadius: "12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "0.6rem", alignItems: "flex-start" }}>
                <strong>{row.subject}</strong>
                <span className="card-muted" style={{ fontSize: "0.8rem", whiteSpace: "nowrap" }}>{formatDate(row.createdAt)}</span>
              </div>
              {hasUnresolvedPlaceholder(row.subject) ? (
                <p className="card-muted" style={{ margin: "0.2rem 0 0", fontSize: "0.78rem", fontStyle: "italic" }}>
                  Shown as typed -- placeholders like {"{{client_name}}"} were filled in per recipient when this sent.
                </p>
              ) : null}
              <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginTop: "0.4rem" }}>
                <span className="tag">{SCOPE_LABELS[row.recipientScope?.scope ?? ""] ?? "Recipients"}</span>
                <span className="tag">{DELIVERY_LABELS[row.deliveryMode] ?? row.deliveryMode}</span>
                <span className="tag">{row.recipientCount} recipient{row.recipientCount === 1 ? "" : "s"}</span>
                {row.deliveryMode !== "in_app" ? (
                  <span className="tag">{row.emailSentCount} sent{row.emailFailedCount > 0 ? `, ${row.emailFailedCount} failed` : ""}</span>
                ) : null}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "0.5rem" }}>
                <p className="card-muted" style={{ margin: 0, fontSize: "0.85rem" }}>
                  By {row.createdByUser?.fullName || row.createdByUser?.email || "Unknown"}
                </p>
                <button
                  type="button"
                  className="btn"
                  style={{ padding: "0.2rem 0.55rem", fontSize: "0.78rem" }}
                  onClick={() => setExpandedId(expanded ? null : row.id)}
                >
                  {expanded ? "Hide recipients" : "View recipients"}
                </button>
              </div>
              {expanded ? (
                <div style={{ marginTop: "0.65rem", paddingTop: "0.65rem", borderTop: "1px solid var(--border)" }}>
                  <RecipientDetail broadcastId={row.id} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </article>
  );
}
