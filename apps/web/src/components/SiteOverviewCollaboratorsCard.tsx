"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type CollaboratorRow = {
  id: string;
  userId: string;
  role: string;
  email: string;
  fullName?: string | null;
};

type ClientTeamRow = CollaboratorRow & { isOwner: boolean };

type Props = {
  siteId: string;
  currentUserId: string;
  clientId: string;
};

export default function SiteOverviewCollaboratorsCard({ siteId, currentUserId, clientId }: Props) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<CollaboratorRow[]>([]);
  const [clientTeam, setClientTeam] = useState<ClientTeamRow[]>([]);
  const [platformAdmins, setPlatformAdmins] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/sites/${siteId}/collaborators`, { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (!cancelled) {
            setError((data as { error?: string }).error ?? "Could not load collaborators");
          }
          return;
        }
        if (!cancelled) {
          setRows((data as { collaborators?: CollaboratorRow[] }).collaborators ?? []);
          setClientTeam((data as { clientTeam?: ClientTeamRow[] }).clientTeam ?? []);
          setPlatformAdmins((data as { platformAdmins?: string[] }).platformAdmins ?? []);
        }
      } catch {
        if (!cancelled) {
          setError("Could not load collaborators");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [siteId, open]);

  function getInitial(row: CollaboratorRow): string {
    const source = (row.fullName?.trim() || row.email.trim() || "?").charAt(0);
    return source.toUpperCase();
  }

  return (
    <article className="card">
      <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "flex-start" }}>
        <div>
          <h3 className="card-title">Collaborators</h3>
          <p className="card-muted" style={{ marginBottom: 0 }}>{clientTeam.length} with access via client team</p>
        </div>
        <button
          type="button"
          className="btn"
          onClick={() => setOpen(true)}
          title="Manage access"
          aria-label="Manage access"
          style={{
            width: "2.3rem",
            height: "2.3rem",
            borderRadius: "999px",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0
          }}
        >
          <span style={{ fontSize: "1.2rem", lineHeight: 1 }}>+</span>
        </button>
      </div>

      {loading ? <p className="card-muted" style={{ marginTop: "0.85rem", marginBottom: 0 }}>Loading…</p> : null}
      {error ? <p className="form-error" style={{ marginTop: "0.85rem", marginBottom: 0 }}>{error}</p> : null}

      {!loading && !error ? (
        <div style={{ display: "grid", gap: "0.55rem", marginTop: "0.9rem" }}>
          {clientTeam.map((row) => (
            <div
              key={row.id}
              style={{
                display: "grid",
                gridTemplateColumns: "34px minmax(0, 1fr) auto",
                alignItems: "center",
                gap: "0.6rem",
                paddingBottom: "0.45rem",
                borderBottom: "1px solid var(--border)"
              }}
            >
              <div
                aria-hidden
                style={{
                  width: "34px",
                  height: "34px",
                  borderRadius: "999px",
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  display: "grid",
                  placeItems: "center",
                  fontWeight: 700,
                  fontSize: "0.82rem"
                }}
              >
                {getInitial(row)}
              </div>
              <div style={{ minWidth: 0 }}>
                <p style={{ margin: 0, fontWeight: 600 }}>{row.fullName ?? row.email}</p>
                <p style={{ margin: "0.15rem 0 0", color: "var(--muted)", fontSize: "0.82rem", overflow: "hidden", textOverflow: "ellipsis" }}>{row.email}</p>
              </div>
              <span className="tag" style={{ textTransform: "capitalize" }}>{row.isOwner ? "owner" : row.role}</span>
            </div>
          ))}
        </div>
      ) : null}

      {!loading && !error && clientTeam.length === 0 ? (
        <p className="card-muted" style={{ marginTop: "0.85rem", marginBottom: 0 }}>
          No client team members yet.
        </p>
      ) : null}

      {!loading && !error && platformAdmins.length > 0 ? (
        <p className="card-muted" style={{ marginTop: "0.75rem", marginBottom: 0, fontSize: "0.8rem" }}>
          Platform admin{platformAdmins.length === 1 ? "" : "s"} ({platformAdmins.join(", ")}) also has full access
          to this app for support, independent of this list.
        </p>
      ) : null}

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Manage collaborators"
          onClick={() => setOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 70,
            background: "rgba(15, 23, 42, 0.68)",
            display: "grid",
            placeItems: "center",
            padding: "1rem"
          }}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            style={{
              width: "min(960px, 100%)",
              maxHeight: "min(88vh, 920px)",
              overflow: "auto",
              borderRadius: "24px",
              border: "1px solid var(--border)",
              background: "linear-gradient(180deg, rgba(255,255,255,0.99), rgba(247,249,252,0.98))",
              boxShadow: "0 32px 80px rgba(15, 23, 42, 0.28)",
              padding: "1.25rem"
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "flex-start", marginBottom: "1rem" }}>
              <div>
                <h2 style={{ margin: 0 }}>Collaborators</h2>
                <p className="card-muted" style={{ margin: "0.4rem 0 0" }}>
                  New invites now belong at the client/project level so teammates inherit access across all apps in this client.
                </p>
              </div>
              <button type="button" className="btn" onClick={() => setOpen(false)}>
                Close
              </button>
            </div>

            <div style={{ display: "grid", gap: "0.85rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "center", padding: "0.85rem 1rem", border: "1px solid var(--border)", borderRadius: "12px", background: "var(--surface)" }}>
                <div>
                  <p style={{ margin: 0, fontWeight: 600 }}>Client team access</p>
                  <p className="card-muted" style={{ margin: "0.2rem 0 0", fontSize: "0.85rem" }}>
                    Invite admins and collaborators once at the client level instead of per app.
                  </p>
                </div>
                <Link href={`/clients/${clientId}/team`} className="btn" onClick={() => setOpen(false)}>
                  Open client team
                </Link>
              </div>

              <div style={{ display: "grid", gap: "0.55rem" }}>
                <h4 style={{ margin: 0, fontSize: "0.92rem" }}>Client team ({clientTeam.length})</h4>
                <p className="card-muted" style={{ margin: 0, fontSize: "0.82rem" }}>
                  These people already have access to this app, inherited from the client team.
                </p>
                {clientTeam.length > 0 ? clientTeam.map((row) => (
                  <div key={row.id} style={{ display: "grid", gridTemplateColumns: "34px minmax(0, 1fr) auto", alignItems: "center", gap: "0.6rem", paddingBottom: "0.45rem", borderBottom: "1px solid var(--border)" }}>
                    <div
                      aria-hidden
                      style={{ width: "34px", height: "34px", borderRadius: "999px", background: "var(--surface)", border: "1px solid var(--border)", display: "grid", placeItems: "center", fontWeight: 700, fontSize: "0.82rem" }}
                    >
                      {getInitial(row)}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <p style={{ margin: 0, fontWeight: 600 }}>{row.fullName ?? row.email}</p>
                      <p style={{ margin: "0.15rem 0 0", color: "var(--muted)", fontSize: "0.82rem", overflow: "hidden", textOverflow: "ellipsis" }}>{row.email}</p>
                    </div>
                    <span className="tag" style={{ textTransform: "capitalize" }}>{row.isOwner ? "owner" : row.role}</span>
                  </div>
                )) : (
                  <p className="card-muted" style={{ margin: 0 }}>No client team members yet.</p>
                )}
              </div>

              <div style={{ display: "grid", gap: "0.55rem" }}>
                <h4 style={{ margin: 0, fontSize: "0.92rem" }}>Legacy app-level records</h4>
                <p className="card-muted" style={{ margin: 0, fontSize: "0.82rem" }}>
                  Existing app-specific collaborator records still load for compatibility, but new invites should be created from the client team page.
                </p>
                {rows.length > 0 ? rows.map((row) => (
                  <div key={row.id} style={{ display: "grid", gridTemplateColumns: "34px minmax(0, 1fr) auto", alignItems: "center", gap: "0.6rem", paddingBottom: "0.45rem", borderBottom: "1px solid var(--border)" }}>
                    <div
                      aria-hidden
                      style={{ width: "34px", height: "34px", borderRadius: "999px", background: "var(--surface)", border: "1px solid var(--border)", display: "grid", placeItems: "center", fontWeight: 700, fontSize: "0.82rem" }}
                    >
                      {getInitial(row)}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <p style={{ margin: 0, fontWeight: 600 }}>{row.fullName ?? row.email}</p>
                      <p style={{ margin: "0.15rem 0 0", color: "var(--muted)", fontSize: "0.82rem", overflow: "hidden", textOverflow: "ellipsis" }}>{row.email}</p>
                    </div>
                    <span className="tag" style={{ textTransform: "capitalize" }}>{row.role}</span>
                  </div>
                )) : (
                  <p className="card-muted" style={{ margin: 0 }}>No app-specific collaborator records yet.</p>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </article>
  );
}
