import { auth } from "@/lib/auth.config";
import PendingBadge from "@/components/PendingBadge";
import SiteCollaboratorManager from "@/components/SiteCollaboratorManager";

type Params = { params: Promise<{ siteId: string }> };

export default async function AppTeamPage({ params }: Params) {
  const { siteId } = await params;
  const session = await auth();

  return (
    <div className="page-stack">
      <article className="card">
        <h2 style={{ marginTop: 0, display: "flex", alignItems: "center", gap: "0.5rem" }}>
          App Team
          <PendingBadge reason="Invite links are available. If email is not configured, copy links manually." />
        </h2>
        <p className="card-muted" style={{ marginBottom: "1rem" }}>
          Manage app collaborators. Existing users can be added directly, or invited with a single-use token link. Admins can invite admins and collaborators. Collaborators can invite collaborators only.
        </p>
        <SiteCollaboratorManager siteId={siteId} currentUserId={session?.user?.id ?? ""} />
      </article>
    </div>
  );
}
