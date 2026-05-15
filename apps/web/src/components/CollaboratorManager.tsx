"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PlusIcon } from "@/components/JongoIcons";

type Collaborator = {
  id: string;
  userId: string;
  role: string;
  email: string;
  fullName?: string | null;
};

type Props = {
  organizationId: string;
  collaborators: Collaborator[];
  currentUserId: string;
};

const ROLES = ["admin", "operator", "viewer"] as const;

export default function CollaboratorManager({ organizationId, collaborators, currentUserId }: Props) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "operator" | "viewer">("operator");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviteError(null);
    setInviteLoading(true);

    try {
      const res = await fetch(`/api/organizations/${organizationId}/collaborators`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), role })
      });

      const data = await res.json();

      if (!res.ok) {
        setInviteError(data.error ?? "Failed to add collaborator");
        return;
      }

      setEmail("");
      router.refresh();
    } catch {
      setInviteError("Network error — please try again");
    } finally {
      setInviteLoading(false);
    }
  }

  async function handleRemove(collaboratorId: string) {
    setRemovingId(collaboratorId);
    try {
      await fetch(`/api/organizations/${organizationId}/collaborators/${collaboratorId}`, {
        method: "DELETE"
      });
      router.refresh();
    } finally {
      setRemovingId(null);
    }
  }

  async function handleRoleChange(collaboratorId: string, newRole: string) {
    try {
      await fetch(`/api/organizations/${organizationId}/collaborators/${collaboratorId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: newRole })
      });
      router.refresh();
    } catch {
      // silent — refresh won't happen but no crash
    }
  }

  return (
    <div>
      {/* Existing collaborators */}
      <div style={{ marginBottom: "1rem" }}>
        {collaborators.map((c) => (
          <div
            key={c.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.75rem",
              padding: "0.5rem 0",
              borderBottom: "1px solid var(--border)"
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ margin: 0, fontWeight: 600, fontSize: "0.9rem" }}>
                {c.fullName ?? c.email}
              </p>
              {c.fullName && (
                <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--muted)" }}>{c.email}</p>
              )}
            </div>
            {c.role === "owner" ? (
              <span className="tag">owner</span>
            ) : (
              <select
                value={c.role}
                onChange={(e) => handleRoleChange(c.id, e.target.value)}
                className="form-select"
                style={{ width: "auto", fontSize: "0.85rem", padding: "0.25rem 0.45rem" }}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            )}
            {c.role !== "owner" && c.userId !== currentUserId && (
              <button
                onClick={() => handleRemove(c.id)}
                disabled={removingId === c.id}
                className="btn btn-danger"
                style={{ padding: "0.3rem 0.55rem", fontSize: "0.8rem" }}
              >
                {removingId === c.id ? "…" : "Remove"}
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Invite form */}
      <form onSubmit={handleInvite} className="form-row">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="user@example.com"
          required
          className="form-input"
          style={{ flex: "1 1 180px" }}
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as typeof role)}
          className="form-select"
          style={{ width: "auto", minWidth: "128px" }}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <button type="submit" className="btn" disabled={inviteLoading}>
          <PlusIcon className="btn-icon" />
          {inviteLoading ? "Adding…" : "Add"}
        </button>
      </form>
      {inviteError && (
        <p className="form-error" style={{ marginTop: "0.5rem" }}>{inviteError}</p>
      )}
      <p className="form-help">
        The user must have an existing account to be added.
      </p>
    </div>
  );
}
