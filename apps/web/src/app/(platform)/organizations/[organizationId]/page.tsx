import Link from "next/link";
import { notFound } from "next/navigation";
import { getSiteWorkspace, getClientWorkspace } from "@/lib/repositories";
import { getCoolifyOverview } from "@/lib/coolify";
import CreateSiteForm from "@/components/CreateSiteForm";
import CollaboratorManager from "@/components/CollaboratorManager";
import CoolifyProjectMappingForm from "@/components/CoolifyProjectMappingForm";
import { auth } from "@/lib/auth.config";
import { ArrowRightIcon } from "@/components/JongoIcons";

type Params = { params: Promise<{ organizationId: string }> };

async function getCollaborators(organizationId: string) {
  try {
    const { db } = await import("@/lib/db");
    const rows = await db.collaborator.findMany({
      where: { organizationId },
      include: { user: { select: { id: true, email: true, fullName: true } } },
      orderBy: { createdAt: "asc" }
    });
    const pendingInviteLogs = await db.auditLog.findMany({
      where: {
        organizationId,
        action: "collaborator_invited_pending"
      },
      orderBy: { createdAt: "desc" },
      take: 100
    });

    const collaborators = rows.map((c: any) => ({
      id: c.id,
      userId: c.userId,
      role: c.role,
      email: c.user.email,
      fullName: c.user.fullName
    }));

    const existingEmails = new Set(collaborators.map((c: any) => c.email.toLowerCase()));
    const pendingInvites = pendingInviteLogs
      .map((log: any) => {
        const details = (log.details ?? {}) as {
          email?: string;
          role?: string;
          status?: string;
          delivery?: string;
          note?: string;
        };
        const email = details.email?.toLowerCase().trim();
        if (!email || existingEmails.has(email)) return null;
        return {
          id: log.id,
          email,
          role: details.role ?? "viewer",
          status: details.status ?? "pending",
          delivery: details.delivery ?? "not_configured",
          note: details.note ?? "Email delivery not configured yet.",
          createdAt: log.createdAt
        };
      })
      .filter((item: any): item is NonNullable<typeof item> => Boolean(item));

    return { collaborators, pendingInvites };
  } catch {
    return { collaborators: [], pendingInvites: [] };
  }
}

export default async function OrganizationDetailPage({ params }: Params) {
  const { organizationId } = await params;
  const session = await auth();
  const client = await getClientWorkspace(organizationId, {
    userId: session?.user?.id,
    email: session?.user?.email
  });

  if (!client) {
    notFound();
  }

  const [clientSites, collaboratorData, overview] = await Promise.all([
    Promise.all(client.siteIds.map((siteId) => getSiteWorkspace(siteId))),
    client.dbId ? getCollaborators(client.dbId) : Promise.resolve({ collaborators: [], pendingInvites: [] }),
    getCoolifyOverview()
  ]);
  const visibleSites = clientSites.filter((site): site is NonNullable<typeof site> => Boolean(site));
  const collaborators = collaboratorData.collaborators;
  const pendingInvites = collaboratorData.pendingInvites;

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
          <h3 className="card-title">Sites</h3>
          {visibleSites.length === 0 ? (
            <p className="card-muted">No sites yet. Use the button above to add one.</p>
          ) : (
            <div style={{ display: "grid", gap: "0.65rem" }}>
              {visibleSites.map((site) => (
                <div key={site.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.65rem", flexWrap: "wrap" }}>
                  <Link href={`/sites/${site.id}`} className="action-link" style={{ fontWeight: 600 }}>
                    {site.name} <ArrowRightIcon className="btn-icon" />
                  </Link>
                  <div style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
                    <span className={`status-chip ${site.status}`}>{site.status}</span>
                    {site.ownershipState !== "mapped" ? (
                      <span className="tag tag-warning" style={{ fontSize: "0.75rem" }}>
                        {site.ownershipDiagnostic}
                      </span>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </article>

        <article className="card">
          <h3 className="card-title">Activity</h3>
          {client.recentActivity.length === 0 ? (
            <p className="card-muted">No activity yet.</p>
          ) : (
            <>
              <p className="card-muted" style={{ marginBottom: "0.6rem" }}>
                {client.recentActivity.length} item{client.recentActivity.length === 1 ? "" : "s"}
              </p>
              {client.recentActivity.map((item) => (
                <p key={item} style={{ margin: "0.45rem 0", fontSize: "0.9rem" }}>- {item}</p>
              ))}
            </>
          )}
        </article>

        {client.dbId && (
          <article className="card">
            <h3 className="card-title">Team</h3>
            <p className="card-muted" style={{ marginBottom: "1rem" }}>Invite and manage who can access this client workspace.</p>
            <CollaboratorManager
              organizationId={client.dbId}
              collaborators={collaborators}
              pendingInvites={pendingInvites}
              currentUserId={session?.user?.id ?? ""}
            />
          </article>
        )}

        {client.dbId && (
          <article className="card">
            <h3 className="card-title">Coolify Project</h3>
            <p className="card-muted" style={{ marginBottom: "1rem" }}>
              Link this client workspace to a Coolify project so sites deployed under it are automatically owned here.
            </p>
            {!client.coolifyProjectId && (
              <div className="diagnostic-banner" style={{ marginBottom: "1rem" }}>
                <strong>No Coolify project mapped.</strong> Sites belonging to this client may appear as unowned in the Sites directory until a project is selected.
              </div>
            )}
            <CoolifyProjectMappingForm
              organizationDbId={client.dbId}
              currentProjectId={client.coolifyProjectId}
              currentProjectName={client.coolifyProjectName}
              availableProjects={overview.projects.map((project) => ({
                id: project.id,
                name: project.name
              }))}
            />
          </article>
        )}
      </section>
    </div>
  );
}
