"use client";

import { useEffect, useState } from "react";
import CollaboratorManager from "@/components/CollaboratorManager";

type TeamMember = {
  id: string;
  name: string;
  email: string;
  role: string;
};

type Props = {
  organizationId?: string;
  currentUserId: string;
};

type CollaboratorsResponse = {
  collaborators?: Array<{
    id: string;
    userId: string;
    role: string;
    email: string;
    fullName?: string | null;
  }>;
};

export default function ClientOverviewCollaboratorsCard({ organizationId, currentUserId }: Props) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!organizationId) {
        setRows([]);
        setError(null);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/organizations/${organizationId}/collaborators`, { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (!cancelled) {
            setError((data as { error?: string }).error ?? "Could not load team members");
          }
          return;
        }
        if (!cancelled) {
          const collaborators = (data as CollaboratorsResponse).collaborators ?? [];
          setRows(
            collaborators.map((member) => ({
              id: member.id,
              name: member.fullName || member.email,
              email: member.email,
              role: member.role
            }))
          );
        }
      } catch {
        if (!cancelled) {
          setError("Could not load team members");
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
  }, [organizationId, open]);

  function getInitial(member: TeamMember): string {
    const source = (member.name?.trim() || member.email.trim() || "?").charAt(0);
    return source.toUpperCase();
  }

  return (
    <article className="card">
      <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "flex-start" }}>
        <div>
          <h3 className="card-title">Team</h3>
          <p className="card-muted" style={{ marginBottom: 0 }}>{rows.length} member{rows.length === 1 ? "" : "s"}</p>
        </div>
        <button
          type="button"
          className="btn"
          onClick={() => setOpen(true)}
          disabled={!organizationId}
          title={organizationId ? "Manage team" : "Team unavailable"}
          aria-label={organizationId ? "Manage team" : "Team unavailable"}
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

      {!organizationId ? (
        <p className="card-muted" style={{ marginTop: "0.85rem", marginBottom: 0 }}>
          Team access becomes available once this client is linked to a database-backed organization.
        </p>
      ) : null}

      {organizationId && loading ? <p className="card-muted" style={{ marginTop: "0.85rem", marginBottom: 0 }}>Loading...</p> : null}
      {organizationId && error ? <p className="form-error" style={{ marginTop: "0.85rem", marginBottom: 0 }}>{error}</p> : null}

      {organizationId && !loading && !error ? (
        <div style={{ display: "grid", gap: "0.55rem", marginTop: "0.9rem" }}>
          {rows.map((member) => (
            <div
              key={member.id}
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
                {getInitial(member)}
              </div>
              <div style={{ minWidth: 0 }}>
                <p style={{ margin: 0, fontWeight: 600 }}>{member.name}</p>
                <p style={{ margin: "0.15rem 0 0", color: "var(--muted)", fontSize: "0.82rem", overflow: "hidden", textOverflow: "ellipsis" }}>{member.email}</p>
              </div>
              <span className="tag" style={{ textTransform: "capitalize" }}>{member.role}</span>
            </div>
          ))}
        </div>
      ) : null}

      {organizationId && !loading && !error && rows.length === 0 ? (
        <p className="card-muted" style={{ marginTop: "0.85rem", marginBottom: 0 }}>
          No team members yet.
        </p>
      ) : null}

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={organizationId ? "Manage team" : "Team unavailable"}
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
                <h2 style={{ margin: 0 }}>Team Access</h2>
                <p className="card-muted" style={{ margin: "0.4rem 0 0" }}>
                  Manage admins and collaborators at the client level. Team access flows across all apps in this project.
                </p>
              </div>
              <button type="button" className="btn" onClick={() => setOpen(false)}>
                Close
              </button>
            </div>

            <div style={{ display: "grid", gap: "0.85rem" }}>
              {organizationId ? (
                <CollaboratorManager organizationId={organizationId} currentUserId={currentUserId} />
              ) : (
                <p className="card-muted" style={{ margin: 0 }}>
                  This client is not linked to a database-backed organization yet.
                </p>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </article>
  );
}
