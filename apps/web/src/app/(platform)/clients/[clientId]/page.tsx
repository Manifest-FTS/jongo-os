import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth.config";
import { getClientWorkspace, getSiteWorkspace, isClientAdmin, listSiteDirectory } from "@/lib/repositories";
import { ArrowRightIcon } from "@/components/JongoIcons";
import PendingBadge from "@/components/PendingBadge";

type Params = { params: Promise<{ clientId: string }> };

export default async function ClientDetailPage({ params }: Params) {
  const { clientId } = await params;
  const session = await auth();
  const client = await getClientWorkspace(clientId, {
    userId: session?.user?.id,
    email: session?.user?.email
  });

  if (!client) {
    notFound();
  }

  const viewer = {
    userId: session?.user?.id,
    email: session?.user?.email
  };

  const visibleSites = client.dataSource === "db"
    ? (await listSiteDirectory(viewer)).filter((site) => site.clientId === client.id)
    : (await Promise.all(client.siteIds.map((siteId) => getSiteWorkspace(siteId, viewer)))).filter(
        (site): site is NonNullable<typeof site> => Boolean(site)
      );
  const canViewInternalNotes = Boolean(session?.user?.id && client.dbId && await isClientAdmin(client.dbId, session.user.id));

  return (
    <div className="page-stack">
      <section className="grid" style={{ marginBottom: "1rem" }}>
        <article className="card">
          <h3 className="card-title">Profile & Contact</h3>
          <p style={{ margin: "0.35rem 0", fontSize: "0.92rem" }}>Client: <strong>{client.name}</strong></p>
          <p className="card-muted" style={{ margin: 0 }}>{client.summary || "No profile notes yet."}</p>
        </article>

        {canViewInternalNotes ? (
          <article className="card">
            <h3 className="card-title" style={{ display: "flex", alignItems: "center", gap: "0.45rem" }}>
              Persistent Notes <PendingBadge reason="Client notes storage is not yet connected. This section will allow saving handoff context and operational preferences." />
            </h3>
            <p className="card-muted" style={{ marginBottom: "0.6rem" }}>
              Use this area for handoff context, operational preferences, and known constraints.
            </p>
            <p style={{ margin: 0, fontSize: "0.88rem" }}>No stored notes yet.</p>
          </article>
        ) : null}

        <article className="card">
          <h3 className="card-title">App Summary</h3>
          <p style={{ margin: "0.35rem 0", fontSize: "0.92rem" }}>
            {visibleSites.length} app{visibleSites.length === 1 ? "" : "s"} currently linked to this client.
          </p>
          <p style={{ margin: "0.35rem 0 0", fontSize: "0.92rem" }}>
            <Link href={`/clients/${clientId}/apps`} className="action-link">
              Open app directory <ArrowRightIcon className="btn-icon" />
            </Link>
          </p>
        </article>
      </section>

      <article className="card">
        <h3 className="card-title">Recent Activity</h3>
        {client.recentActivity.length === 0 ? (
          <p className="card-muted">No activity yet.</p>
        ) : (
          <div style={{ display: "grid", gap: "0.5rem", marginTop: "0.6rem" }}>
            {client.recentActivity.slice(0, 8).map((item) => (
              <p key={item} style={{ margin: 0, fontSize: "0.9rem" }}>{item}</p>
            ))}
          </div>
        )}
      </article>
    </div>
  );
}
