"use client";

import { useEffect, useMemo, useState } from "react";
import { PlusIcon } from "@/components/JongoIcons";
import { normalizeRole } from "@/lib/roles";

type SiteCollaborator = {
  id: string;
  userId: string;
  role: string;
  email: string;
  fullName?: string | null;
};

type Props = {
  siteId: string;
  currentUserId: string;
};

export default function SiteCollaboratorManager({ siteId, currentUserId }: Props) {
  const [rows, setRows] = useState<SiteCollaborator[]>([]);
  const [callerRole, setCallerRole] = useState<"admin" | "collaborator">("collaborator");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "collaborator">("collaborator");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const roleOptions = useMemo(() => {
    return callerRole === "admin" ? ["admin", "collaborator"] as const : ["collaborator"] as const;
  }, [callerRole]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/collaborators`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to load app collaborators");
        return;
      }

      setRows(data.collaborators ?? []);
      setCallerRole(data.callerRole === "admin" ? "admin" : "collaborator");
      if (data.callerRole !== "admin") {
        setRole("collaborator");
      }
    } catch {
      setError("Network error while loading app team");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [siteId]);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const res = await fetch(`/api/sites/${siteId}/collaborators`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), role })
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Failed to add collaborator");
        return;
      }

      setNotice("Collaborator added.");
      setEmail("");
      await load();
    } catch {
      setError("Network error while inviting collaborator");
    } finally {
      setBusy(false);
    }
  }

  async function removeCollaborator(collaboratorId: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/collaborators/${collaboratorId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((data as { error?: string }).error ?? "Failed to remove collaborator");
        return;
      }
      await load();
    } catch {
      setError("Network error while removing collaborator");
    } finally {
      setBusy(false);
    }
  }

  async function updateRole(collaboratorId: string, newRole: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sites/${siteId}/collaborators/${collaboratorId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: newRole })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((data as { error?: string }).error ?? "Failed to update role");
        return;
      }
      await load();
    } catch {
      setError("Network error while updating role");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {loading ? <p className="card-muted">Loading app team…</p> : null}

      {!loading && rows.length === 0 ? (
        <p className="card-muted">No app collaborators yet.</p>
      ) : null}

      {!loading ? (
        <div style={{ marginBottom: "1rem", display: "grid", gap: "0.55rem" }}>
          {rows.map((row) => {
            const normalized = normalizeRole(row.role);
            const isSelf = row.userId === currentUserId;
            return (
              <div key={row.id} style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "center", borderBottom: "1px solid var(--border)", paddingBottom: "0.45rem" }}>
                <div>
                  <p style={{ margin: 0, fontWeight: 600 }}>{row.fullName ?? row.email}</p>
                  <p style={{ margin: 0, color: "var(--muted)", fontSize: "0.82rem" }}>{row.email}</p>
                </div>

                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  {callerRole === "admin" ? (
                    <select
                      className="form-select"
                      style={{ width: "auto", minWidth: "130px" }}
                      value={normalized}
                      onChange={(e) => updateRole(row.id, e.target.value)}
                      disabled={busy}
                    >
                      {roleOptions.map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="tag">{normalized}</span>
                  )}

                  {callerRole === "admin" && !isSelf ? (
                    <button className="btn btn-danger" style={{ padding: "0.3rem 0.6rem", fontSize: "0.8rem" }} onClick={() => removeCollaborator(row.id)} disabled={busy}>
                      Remove
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      <form onSubmit={invite} className="form-row">
        <input
          className="form-input"
          style={{ flex: "1 1 190px" }}
          type="email"
          placeholder="user@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          disabled={busy}
        />
        <select
          className="form-select"
          style={{ width: "auto", minWidth: "130px" }}
          value={role}
          onChange={(e) => setRole(e.target.value as "admin" | "collaborator")}
          disabled={busy}
        >
          {roleOptions.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <button type="submit" className="btn" disabled={busy}>
          <PlusIcon className="btn-icon" />
          {busy ? "Saving…" : "Invite"}
        </button>
      </form>

      {callerRole !== "admin" ? (
        <p className="form-help" style={{ marginTop: "0.55rem" }}>
          Collaborators can invite collaborators only. Admin invites require app admin access.
        </p>
      ) : null}

      {notice ? <p className="form-help" style={{ marginTop: "0.5rem" }}>{notice}</p> : null}
      {error ? <p className="form-error" style={{ marginTop: "0.5rem" }}>{error}</p> : null}
    </div>
  );
}
