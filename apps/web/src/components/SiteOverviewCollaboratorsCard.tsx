"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRightIcon, PlusIcon } from "@/components/JongoIcons";
import SiteCollaboratorManager from "@/components/SiteCollaboratorManager";

type Props = {
  siteId: string;
  currentUserId: string;
};

export default function SiteOverviewCollaboratorsCard({ siteId, currentUserId }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <article className="card">
      <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "flex-start" }}>
        <div>
          <h3 className="card-title">Collaborators</h3>
          <p className="card-muted" style={{ marginBottom: 0 }}>
            Open the invite modal to add people, adjust roles, or review pending invitations.
          </p>
        </div>
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          <PlusIcon className="btn-icon" />
          Invite
        </button>
      </div>

      <div style={{ display: "grid", gap: "0.5rem", marginTop: "0.9rem" }}>
        <p style={{ margin: 0, fontSize: "0.9rem" }}>
          Role changes and invite management live behind a single, focused modal so the overview stays calm.
        </p>
        <p style={{ margin: 0 }}>
          <Link href={`/apps/${siteId}/team`} className="action-link">
            Open the full team page <ArrowRightIcon className="btn-icon" />
          </Link>
        </p>
      </div>

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
                <h2 style={{ margin: 0 }}>Manage collaborators</h2>
                <p className="card-muted" style={{ marginBottom: 0 }}>
                  Invite teammates, review pending access, and keep access changes in one place.
                </p>
              </div>
              <button type="button" className="btn" onClick={() => setOpen(false)}>
                Close
              </button>
            </div>

            <SiteCollaboratorManager siteId={siteId} currentUserId={currentUserId} />
          </div>
        </div>
      ) : null}
    </article>
  );
}
