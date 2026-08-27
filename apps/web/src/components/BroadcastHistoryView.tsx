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

export default function BroadcastHistoryView() {
  const [rows, setRows] = useState<BroadcastRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
        {rows.map((row) => (
          <div key={row.id} style={{ padding: "0.8rem 0.9rem", border: "1px solid var(--border)", borderRadius: "12px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "0.6rem", alignItems: "flex-start" }}>
              <strong>{row.subject}</strong>
              <span className="card-muted" style={{ fontSize: "0.8rem", whiteSpace: "nowrap" }}>{formatDate(row.createdAt)}</span>
            </div>
            <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginTop: "0.4rem" }}>
              <span className="tag">{SCOPE_LABELS[row.recipientScope?.scope ?? ""] ?? "Recipients"}</span>
              <span className="tag">{DELIVERY_LABELS[row.deliveryMode] ?? row.deliveryMode}</span>
              <span className="tag">{row.recipientCount} recipient{row.recipientCount === 1 ? "" : "s"}</span>
              {row.deliveryMode !== "in_app" ? (
                <span className="tag">{row.emailSentCount} sent{row.emailFailedCount > 0 ? `, ${row.emailFailedCount} failed` : ""}</span>
              ) : null}
            </div>
            <p className="card-muted" style={{ margin: "0.5rem 0 0", fontSize: "0.85rem" }}>
              By {row.createdByUser?.fullName || row.createdByUser?.email || "Unknown"}
            </p>
          </div>
        ))}
      </div>
    </article>
  );
}
