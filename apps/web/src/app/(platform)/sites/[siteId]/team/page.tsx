import Link from "next/link";
import { auth } from "@/lib/auth.config";
import { notFound } from "next/navigation";
import PendingBadge from "@/components/PendingBadge";
import SiteCollaboratorManager from "@/components/SiteCollaboratorManager";
import { getSiteWorkspace } from "@/lib/repositories";
import { isOidcEnabled } from "@/lib/oidc/config";
import { resolveCraftManager } from "@/lib/craft-admin/gate";

type Params = { params: Promise<{ siteId: string }> };

export default async function AppTeamPage({ params }: Params) {
  const { siteId } = await params;
  const session = await auth();

  const workspace = await getSiteWorkspace(siteId, {
    userId: session?.user?.id,
    email: session?.user?.email
  });

  if (!workspace) {
    notFound();
  }

  // Flag off: short-circuits before any Craft lookup, and nothing extra is rendered.
  const showCraftInvite = isOidcEnabled() && workspace.source === "db" && Boolean(session?.user?.id) &&
    (await resolveCraftManager(session!.user!.id!, workspace.id)).ok;

  return (
    <div className="page-stack">
      <article className="card">
        <h2 style={{ marginTop: 0, display: "flex", alignItems: "center", gap: "0.5rem" }}>
          App Team
          <PendingBadge reason="Client-level invites are now the preferred path for granting access across all apps in a project." />
        </h2>
        <p className="card-muted" style={{ marginBottom: "1rem" }}>
          Manage access from the client/project team page so invited users automatically inherit access to every app in this client.
        </p>
        <div style={{ display: "grid", gap: "0.85rem" }}>
          <div style={{ padding: "0.9rem 1rem", border: "1px solid var(--border)", borderRadius: "12px", background: "var(--surface)" }}>
            <p style={{ margin: 0, fontWeight: 600 }}>Use client-level invites</p>
            <p className="card-muted" style={{ margin: "0.25rem 0 0" }}>
              App/resource-specific invites are being phased out in the UI. Manage admins and collaborators once at the client level instead.
            </p>
          </div>

          <div>
            <Link href={`/clients/${workspace.clientId}/team`} className="btn">
              Open client team
            </Link>
          </div>
        </div>
      </article>

      {showCraftInvite ? (
        <article className="card">
          <h3 className="card-title">Invite someone to this app with Jongo Craft access</h3>
          <p className="card-muted">
            Add or invite a person to this app and, optionally, let them sign in to its Craft studio. To manage existing Craft access, use the Jongo Craft panel in the app&apos;s settings.
          </p>
          <SiteCollaboratorManager siteId={workspace.id} currentUserId={session!.user!.id!} craft={{ canGrant: true }} />
        </article>
      ) : null}
    </div>
  );
}
