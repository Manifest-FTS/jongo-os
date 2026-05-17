"use client";

import { useEffect, useMemo, useState } from "react";
import { PlusIcon } from "@/components/JongoIcons";
import PendingBadge from "@/components/PendingBadge";
import { normalizeRole } from "@/lib/roles";

type SiteCollaborator = {
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
  expiresAt: string;
  acceptedAt?: string | null;
  revokedAt?: string | null;
  delivery?: string;
  note?: string | null;
};

type Props = {
  siteId: string;
  currentUserId: string;
};

export default function SiteCollaboratorManager({ siteId, currentUserId }: Props) {
  const [rows, setRows] = useState<SiteCollaborator[]>([]);
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [emailDeliveryConfigured, setEmailDeliveryConfigured] = useState(false);
  const [callerRole, setCallerRole] = useState<"admin" | "collaborator">("collaborator");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "collaborator">("collaborator");
  const [forceInvite, setForceInvite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviteActionBusyId, setInviteActionBusyId] = useState<string | null>(null);

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
      setPendingInvites(data.pendingInvites ?? []);
      setEmailDeliveryConfigured(Boolean(data.emailDeliveryConfigured));
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
    setInviteLink(null);

    try {
      const res = await fetch(`/api/sites/${siteId}/collaborators`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), role, forceInvite })
      });
      const data = await res.json();

      if (!res.ok) {
        if (res.status === 409) {
          setError("User is already a collaborator on this app.");
        } else {
          setError(data.error ?? "Failed to create collaboration invitation");
        }
        return;
      }

      if (data.status === "active") {
        setNotice("Team member added immediately.");
      } else {
        setInviteLink(typeof data.inviteUrl === "string" ? data.inviteUrl : null);
        setNotice(data.message ?? "Invitation created.");
      }
      setEmail("");
      await load();
    } catch {
      setError("Network error while creating collaboration invitation");
    } finally {
      setBusy(false);
    }
  }

  async function copyInviteLink(url?: string | null) {
    const value = url ?? inviteLink;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setNotice("Invite link copied to clipboard.");
    } catch {
      setError("Could not copy invite link. Copy it manually from the field below.");
    }
  }

  async function runInviteAction(invitationId: string, action: "resend" | "regenerate" | "revoke") {
    setInviteActionBusyId(invitationId);
    setError(null);
    setNotice(null);

    try {
      const res = await fetch(`/api/sites/${siteId}/collaborators/invitations/${invitationId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((data as { error?: string }).error ?? `Could not ${action} invite.`);
        return;
      }

      const nextInviteUrl = (data as { inviteUrl?: string }).inviteUrl;
      if (nextInviteUrl) {
        setInviteLink(nextInviteUrl);
      }

      if (action === "revoke") {
        setNotice("Invitation revoked.");
      } else if (action === "resend") {
        setNotice("Invitation resent.");
      } else {
        setNotice("New invitation link generated.");
      }

      await load();
    } catch {
      setError("Network error while managing invitation");
    } finally {
      setInviteActionBusyId(null);
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

      {!loading && rows.length === 0 && pendingInvites.length === 0 ? (
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

      {!loading && pendingInvites.length > 0 ? (
        <div style={{ marginBottom: "1rem", display: "grid", gap: "0.5rem" }}>
          {pendingInvites.map((invite) => (
            <div key={invite.id} style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "center", borderBottom: "1px solid var(--border)", paddingBottom: "0.45rem" }}>
              <div>
                <p style={{ margin: 0, fontWeight: 600 }}>{invite.email}</p>
                <p style={{ margin: 0, color: "var(--muted)", fontSize: "0.82rem" }}>
                  {invite.status === "accepted"
                    ? `Accepted${invite.acceptedAt ? ` · ${new Date(invite.acceptedAt).toLocaleString()}` : ""}`
                    : invite.status === "revoked"
                    ? `Revoked${invite.revokedAt ? ` · ${new Date(invite.revokedAt).toLocaleString()}` : ""}`
                    : invite.status === "expired"
                    ? `Expired · ${new Date(invite.expiresAt).toLocaleString()}`
                    : `Pending invite · expires ${new Date(invite.expiresAt).toLocaleString()}`}
                  {invite.note ? ` · ${invite.note}` : ""}
                </p>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.45rem" }}>
                <span className="tag">{normalizeRole(invite.role)}</span>
                <span className="status-chip unknown">{invite.status ?? "pending"}</span>
                {invite.status === "pending" ? (
                  <>
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
                  </>
                ) : invite.status === "expired" || invite.status === "revoked" ? (
                  <button type="button" className="btn" style={{ padding: "0.25rem 0.5rem", fontSize: "0.78rem" }} onClick={() => runInviteAction(invite.id, "regenerate")} disabled={inviteActionBusyId === invite.id}>
                    Regenerate
                  </button>
                ) : null}
              </div>
            </div>
          ))}
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

      <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.55rem", fontSize: "0.85rem", color: "var(--muted)" }}>
        <input
          type="checkbox"
          checked={forceInvite}
          onChange={(e) => setForceInvite(e.target.checked)}
          disabled={busy}
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

      <div style={{ marginTop: "0.75rem", padding: "0.6rem 0.85rem", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "6px" }}>
        <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--muted)", display: "flex", alignItems: "center", gap: "0.4rem" }}>
          <PendingBadge reason="Email delivery not configured" />
          <span>
            {emailDeliveryConfigured
              ? "Invite emails are sent automatically when SMTP is configured."
              : "Email delivery not configured yet - copy this invite link manually."}
          </span>
        </p>
      </div>

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
