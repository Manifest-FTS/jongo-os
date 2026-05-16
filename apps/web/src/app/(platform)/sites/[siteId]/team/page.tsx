import { auth } from "@/lib/auth.config";
import SiteCollaboratorManager from "@/components/SiteCollaboratorManager";

type Params = { params: Promise<{ siteId: string }> };

export default async function AppTeamPage({ params }: Params) {
  const { siteId } = await params;
  const session = await auth();

  return (
    <div className="page-stack">
      <article className="card">
        <h2 style={{ marginTop: 0 }}>App Team</h2>
        <p className="card-muted" style={{ marginBottom: "1rem" }}>
          Manage app collaborators here. Admins can invite admins and collaborators. Collaborators can invite collaborators only.
        </p>
        <SiteCollaboratorManager siteId={siteId} currentUserId={session?.user?.id ?? ""} />
      </article>
    </div>
  );
}
