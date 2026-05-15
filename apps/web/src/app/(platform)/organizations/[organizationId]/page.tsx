import Link from "next/link";
import { notFound } from "next/navigation";
import { getSiteWorkspace, getClientWorkspace } from "@/lib/repositories";
import CreateSiteForm from "@/components/CreateSiteForm";
import CollaboratorManager from "@/components/CollaboratorManager";
import { auth } from "@/lib/auth.config";

type Params = { params: Promise<{ organizationId: string }> };

async function getCollaborators(organizationId: string) {
  try {
    const { db } = await import("@/lib/db");
    const rows = await db.collaborator.findMany({
      where: { organizationId },
      include: { user: { select: { id: true, email: true, fullName: true } } },
      orderBy: { createdAt: "asc" }
    });
    return rows.map((c: any) => ({
      id: c.id,
      userId: c.userId,
      role: c.role,
      email: c.user.email,
      fullName: c.user.fullName
    }));
  } catch {
    return [];
  }
}

export default async function OrganizationDetailPage({ params }: Params) {
  const { organizationId } = await params;
  const session = await auth();
  const client = await getClientWorkspace(organizationId, session?.user?.id);

  if (!client) {
    notFound();
  }

  const [clientSites, collaborators] = await Promise.all([
    Promise.all(client.siteIds.map((siteId) => getSiteWorkspace(siteId))),
    client.dbId ? getCollaborators(client.dbId) : Promise.resolve([])
  ]);
  const visibleSites = clientSites.filter((site): site is NonNullable<typeof site> => Boolean(site));

  return (
    <div>
      <div className="card" style={{ marginBottom: "1rem", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem" }}>
        <div>
          <p className="card-muted" style={{ marginBottom: "0.35rem" }}>Dashboard / Clients / {client.name}</p>
          <h1 style={{ margin: 0 }}>{client.name}</h1>
          {client.summary && client.summary !== "Client workspace" && (
            <p className="card-muted" style={{ marginTop: "0.35rem" }}>{client.summary}</p>
          )}
        </div>
        {client.dbId && (
          <div style={{ flexShrink: 0, paddingTop: "0.25rem" }}>
            <CreateSiteForm organizationId={client.dbId} />
          </div>
        )}
      </div>

      <section className="grid" style={{ marginBottom: "1rem" }}>
        <article className="card">
          <h3 className="card-title">Sites / Applications</h3>
          {visibleSites.length === 0 ? (
            <p className="card-muted">No sites yet. Use the button above to add one.</p>
          ) : (
            <div>
              {visibleSites.map((site) => (
                <p key={site.id} style={{ margin: "0.5rem 0" }}>
                  <Link href={`/sites/${site.id}`} style={{ color: "var(--accent)", textDecoration: "none" }}>
                    {site.name} →
                  </Link>{" "}
                  <span className={`status-chip ${site.status}`}>{site.status}</span>
                </p>
              ))}
            </div>
          )}
        </article>

        <article className="card">
          <h3 className="card-title">Recent Activity</h3>
          {client.recentActivity.length === 0 ? (
            <p className="card-muted">No activity yet.</p>
          ) : (
            <>
              <p className="card-muted" style={{ marginBottom: "0.6rem" }}>
                {client.recentActivity.length} item{client.recentActivity.length === 1 ? "" : "s"}
              </p>
              {client.recentActivity.map((item) => (
                <p key={item} style={{ margin: "0.45rem 0", fontSize: "0.9rem" }}>• {item}</p>
              ))}
            </>
          )}
        </article>

        {client.dbId && (
          <article className="card">
            <h3 className="card-title">Team Access</h3>
            <p className="card-muted" style={{ marginBottom: "1rem" }}>Manage who has access to this organization.</p>
            <CollaboratorManager
              organizationId={client.dbId}
              collaborators={collaborators}
              currentUserId={session?.user?.id ?? ""}
            />
          </article>
        )}
      </section>
    </div>
  );
}
