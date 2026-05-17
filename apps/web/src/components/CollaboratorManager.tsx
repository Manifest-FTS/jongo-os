"use client";

import { useEffect, useState } from "react";
import { PlusIcon } from "@/components/JongoIcons";
import { normalizeRole } from "@/lib/roles";

type Collaborator = {
  id: string;
  userId: string;
  role: string;
  email: string;
  fullName?: string | null;
};

type PendingInvite = {
  id: string;
  email: string;
  role: string;
  status?: "pending" | "accepted" | "expired" | "revoked";
  inviteUrl?: string | null;
  delivery?: string;
  note?: string;
  expiresAt?: string;
  acceptedAt?: string | null;
  revokedAt?: string | null;
  createdAt?: string;
};

type Props = {
  organizationId: string;
  currentUserId: string;
};

const ROLES = ["admin", "collaborator"] as const;

export default function CollaboratorManager({ organizationId, currentUserId }: Props) {
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [emailDeliveryConfigured, setEmailDeliveryConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "collaborator">("collaborator");
  const [forceInvite, setForceInvite] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteNotice, setInviteNotice] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [inviteActionBusyId, setInviteActionBusyId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setInviteError(null);

    try {
      const res = await fetch(`/api/organizations/${organizationId}/collaborators`, { cache: "no-store" });
      const data = await res.json();

      if (!res.ok) {
        setInviteError(data.error ?? "Failed to load collaborators");
        return;
      }

      setCollaborators(data.collaborators ?? []);
      setPendingInvites(data.pendingInvites ?? []);
      setEmailDeliveryConfigured(Boolean(data.emailDeliveryConfigured));
    } catch {
      setInviteError("Network error - please try again");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [organizationId]);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviteError(null);
    setInviteNotice(null);
    setInviteLink(null);
    setInviteLoading(true);

    try {
      const res = await fetch(`/api/organizations/${organizationId}/collaborators`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), role, forceInvite })
      });

      const data = await res.json();

      if (!res.ok) {
        setInviteError(data.error ?? "Failed to add collaborator");
        return;
      }

      if (data.status === "pending") {
        setInviteNotice(data.message ?? "Invitation pending. Email delivery is not configured yet.");
        if (typeof data.inviteUrl === "string") {
          setInviteLink(data.inviteUrl);
        }
      } else {
        setInviteNotice("Team member added.");
      }

      setEmail("");
      await load();
    } catch {
      setInviteError("Network error - please try again");
    } finally {
      setInviteLoading(false);
    }
  }

  async function handleRemove(collaboratorId: string) {
    setRemovingId(collaboratorId);
    try {
      const res = await fetch(`/api/organizations/${organizationId}/collaborators/${collaboratorId}`, {
        method: "DELETE"
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setInviteError((data as { error?: string }).error ?? "Failed to remove collaborator");
        return;
      }
      await load();
    } finally {
      setRemovingId(null);
    }
  }

  async function handleRoleChange(collaboratorId: string, newRole: string) {
    try {
      const res = await fetch(`/api/organizations/${organizationId}/collaborators/${collaboratorId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: newRole })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setInviteError((data as { error?: string }).error ?? "Failed to update role");
        return;
      }
      await load();
    } catch {
      // no-op on network failure
    }
  }

  async function copyInviteLink(url?: string | null) {
    const value = url ?? inviteLink;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setInviteNotice("Invite link copied to clipboard.");
    } catch {
      setInviteError("Could not copy invite link. Copy it manually from the field below.");
    }
  }

  async function runInviteAction(invitationId: string, action: "resend" | "regenerate" | "revoke") {
    setInviteActionBusyId(invitationId);
    setInviteError(null);
    setInviteNotice(null);

    try {
      const res = await fetch(`/api/organizations/${organizationId}/collaborators/invitations/${invitationId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action })
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setInviteError((data as { error?: string }).error ?? `Could not ${action} invite.`);
        return;
      }

      const nextInviteUrl = (data as { inviteUrl?: string }).inviteUrl;
      if (nextInviteUrl) {
        setInviteLink(nextInviteUrl);
      }

      if (action === "revoke") {
        setInviteNotice("Invitation revoked.");
      } else if (action === "resend") {
        setInviteNotice("Invitation resent.");
      } else {
        setInviteNotice("New invitation link generated.");
      }

      await load();
    } catch {
      setInviteError("Network error - please try again");
    } finally {
      setInviteActionBusyId(null);
    }
  }

  function statusLabel(invite: PendingInvite): string {
    if (invite.status === "accepted") return "accepted";
    if (invite.status === "revoked") return "revoked";
    if (invite.status === "expired") return "expired";
    return "pending";
  }

  return (
    <div>
      {loading ? <p className="card-muted">Loading organization team...</p> : null}

      <div style={{ marginBottom: "1rem" }}>
        {collaborators.length === 0 && pendingInvites.length === 0 ? (
          <p className="card-muted">No team members yet. Invite someone to get started.</p>
        ) : null}

        {collaborators.map((c) => {
          const normalizedRole = normalizeRole(c.role);
          const isSelf = c.userId === currentUserId;

          return (
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
                <p style={{ margin: 0, fontWeight: 600, fontSize: "0.9rem" }}>{c.fullName ?? c.email}</p>
                {c.fullName && <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--muted)" }}>{c.email}</p>}
              </div>

              <select
                value={normalizedRole}
                onChange={(e) => handleRoleChange(c.id, e.target.value)}
                className="form-select"
                style={{ width: "auto", fontSize: "0.85rem", padding: "0.25rem 0.45rem" }}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>

              {!isSelf && (
                <button
                  onClick={() => handleRemove(c.id)}
                  disabled={removingId === c.id}
                  className="btn btn-danger"
                  style={{ padding: "0.3rem 0.55rem", fontSize: "0.8rem" }}
                >
                  {removingId === c.id ? "..." : "Remove"}
                </button>
              )}
            </div>
          );
        })}

        {pendingInvites.map((invite) => (
          <div
            key={invite.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.75rem",
              padding: "0.5rem 0",
              borderBottom: "1px solid var(--border)"
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ margin: 0, fontWeight: 600, fontSize: "0.9rem" }}>{invite.email}</p>
              <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--muted)" }}>
                {invite.status === "accepted"
                  ? `Accepted${invite.acceptedAt ? ` · ${new Date(invite.acceptedAt).toLocaleString()}` : ""}`
                  : invite.status === "revoked"
                  ? `Revoked${invite.revokedAt ? ` · ${new Date(invite.revokedAt).toLocaleString()}` : ""}`
                  : invite.status === "expired"
                  ? `Expired${invite.expiresAt ? ` · ${new Date(invite.expiresAt).toLocaleString()}` : ""}`
                  : `Pending${invite.expiresAt ? ` · Expires ${new Date(invite.expiresAt).toLocaleString()}` : ""}`}
                {invite.note ? ` · ${invite.note}` : ""}
              </p>
            </div>
            <span className="tag">{normalizeRole(invite.role)}</span>
            <span className="status-chip unknown">{statusLabel(invite)}</span>
            {invite.status === "pending" ? (
              <div style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
                <button type="button" className="btn" style={{ padding: "0.25rem 0.5rem", fontSize: "0.78rem" }} onClick={() => copyInviteLink(invite.inviteUrl)} disabled={inviteActionBusyId === invite.id || !invite.inviteUrl}>
                  Copy
                </button>
                <button type="button" className="btn" style={{ padding: "0.25rem 0.5rem", fontSize: "0.78rem" }} onClick={() => runInviteAction(invite.id, "resend")} disabled={inviteActionBusyId === invite.id}>
                  Resend
                </button>
                <button type="button" className="btn" style={{ padding: "0.25rem 0.5rem", fontSize: "0.78rem" }} onClick={() => runInviteAction(invite.id, "regenerate")} disabled={inviteActionBusyId === invite.id}>
                  Regenerate
                </button>
                <button type="button" className="btn btn-danger" style={{ padding: "0.25rem 0.5rem", fontSize: "0.78rem" }} onClick={() => runInviteAction(invite.id, "revoke")} disabled={inviteActionBusyId === invite.id}>
                  Revoke
                </button>
              </div>
            ) : invite.status === "expired" || invite.status === "revoked" ? (
              <button type="button" className="btn" style={{ padding: "0.25rem 0.5rem", fontSize: "0.78rem" }} onClick={() => runInviteAction(invite.id, "regenerate")} disabled={inviteActionBusyId === invite.id}>
                Regenerate
              </button>
            ) : null}
          </div>
        ))}
      </div>

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
          {inviteLoading ? "Adding..." : "Add"}
        </button>
      </form>

      <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.55rem", fontSize: "0.85rem", color: "var(--muted)" }}>
        <input
          type="checkbox"
          checked={forceInvite}
          onChange={(e) => setForceInvite(e.target.checked)}
          disabled={inviteLoading}
        />
        Always issue invite token (even when account already exists)
      </label>

      {inviteLink && !emailDeliveryConfigured ? (
        <div style={{ marginTop: "0.75rem", padding: "0.6rem 0.85rem", background: "var(--surface)", border: "1px solid var(--warning)", borderRadius: "6px" }}>
          <p style={{ margin: "0 0 0.45rem", fontSize: "0.82rem", color: "var(--warning)" }}>
            Email delivery not configured yet - copy this invite link manually
          </p>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <input className="form-input" value={inviteLink} readOnly />
            <button type="button" className="btn" onClick={() => copyInviteLink()}>Copy link</button>
          </div>
        </div>
      ) : null}

      {inviteError && <p className="form-error" style={{ marginTop: "0.5rem" }}>{inviteError}</p>}
      {inviteNotice && <p className="form-help" style={{ marginTop: "0.5rem" }}>{inviteNotice}</p>}
      <p className="form-help">
        {emailDeliveryConfigured
          ? "Invite by email. SMTP delivery is enabled and invite links are sent automatically."
          : "Email delivery not configured yet - copy this invite link manually."}
      </p>
    </div>
  );
}
