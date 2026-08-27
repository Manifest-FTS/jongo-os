"use client";

import { useEffect, useState } from "react";

type AdminRow = {
  id: string;
  email: string;
  fullName: string | null;
  isSeed: boolean;
  createdAt: string | null;
  grantedBy: string | null;
};

export default function PlatformAdminsPanel() {
  const [admins, setAdmins] = useState<AdminRow[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/platform/admins", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((data as { error?: string }).error ?? "Could not load platform admins");
        return;
      }
      setAdmins((data as { admins?: AdminRow[] }).admins ?? []);
      setCanManage(Boolean((data as { canManage?: boolean }).canManage));
    } catch {
      setError("Could not load platform admins");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    setError(null);
    try {
      const res = await fetch("/api/platform/admins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((data as { error?: string }).error ?? "Could not add platform admin");
        return;
      }
      setEmail("");
      await load();
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(id: string) {
    setRemovingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/platform/admins/${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((data as { error?: string }).error ?? "Could not remove platform admin");
        return;
      }
      await load();
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <article className="card tone-card">
      <h3 className="card-title">Platform Admins</h3>
      <p className="card-muted">Full platform access across every client and app.</p>

      {loading ? <p className="card-muted" style={{ marginTop: "0.85rem" }}>Loading…</p> : null}
      {error ? <p className="form-error" style={{ marginTop: "0.85rem" }}>{error}</p> : null}

      {!loading ? (
        <div style={{ display: "grid", gap: "0.5rem", marginTop: "0.85rem" }}>
          {admins.map((admin) => (
            <div
              key={admin.id}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.6rem", padding: "0.5rem 0.65rem", borderRadius: "8px", background: "var(--surface)" }}
            >
              <div style={{ minWidth: 0 }}>
                <p style={{ margin: 0, fontWeight: 600 }}>{admin.fullName || admin.email}</p>
                <p className="card-muted" style={{ margin: "0.1rem 0 0", fontSize: "0.8rem" }}>
                  {admin.email}
                  {admin.isSeed ? " — seed admin" : admin.grantedBy ? ` — granted by ${admin.grantedBy}` : ""}
                </p>
              </div>
              {canManage && !admin.isSeed ? (
                <button
                  type="button"
                  className="btn btn-danger"
                  style={{ padding: "0.25rem 0.6rem", fontSize: "0.8rem" }}
                  onClick={() => void handleRemove(admin.id)}
                  disabled={removingId === admin.id}
                >
                  {removingId === admin.id ? "Removing…" : "Remove"}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {canManage ? (
        <form onSubmit={handleAdd} style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
          <input
            type="email"
            className="form-input"
            placeholder="teammate@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={{ flex: 1 }}
          />
          <button type="submit" className="btn" disabled={adding}>
            {adding ? "Adding…" : "Grant admin"}
          </button>
        </form>
      ) : (
        <p className="card-muted" style={{ marginTop: "1rem", fontSize: "0.82rem" }}>
          Only the seed admin can grant or revoke platform admin access.
        </p>
      )}
    </article>
  );
}
