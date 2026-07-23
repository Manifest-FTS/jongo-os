import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth.config";
import { getClientWorkspace, getSiteWorkspace, isClientAdmin, listSiteDirectory } from "@/lib/repositories";
import CreateSiteForm from "@/components/CreateSiteForm";
import { ArrowRightIcon } from "@/components/JongoIcons";
import { getCoolifyOverview } from "@/lib/coolify";
import { buildAvailableCoolifyAppOptions } from "@/lib/coolify-app-picker";
import SiteDirectoryView from "@/components/SiteDirectoryView";

type Params = { params: Promise<{ clientId: string }> };

export default async function ClientAppsPage({ params }: Params) {
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

  const apps = client.dataSource === "db"
    ? (await listSiteDirectory(viewer)).filter((site) => site.clientId === client.id)
    : (await Promise.all(client.siteIds.map((siteId) => getSiteWorkspace(siteId, viewer)))).filter(
        (site): site is NonNullable<typeof site> => Boolean(site)
      );
  const linkedProjectIds = new Set((client.linkedCoolifyProjects ?? []).map((project) => project.coolifyProjectId));
  const overview = client.dbId ? await getCoolifyOverview() : null;
  const availableApps = overview
    ? buildAvailableCoolifyAppOptions(
        overview,
        linkedProjectIds,
        apps.map((app) => ({
          coolifyServiceUuid: app.coolifyServiceUuid,
          deployTargetId: app.deployTargetId,
          name: app.name
        }))
      )
    : [];
  const canManageClient = Boolean(session?.user?.id && client.dbId && await isClientAdmin(client.dbId, session.user.id));

  return (
    <div className="page-stack">
      <div className="card" style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "center" }}>
        <div>
          <h2 style={{ margin: 0 }}>Apps</h2>
          <p className="card-muted" style={{ marginTop: "0.35rem" }}>All apps mapped to this client workspace.</p>
        </div>
        {client.dbId ? <CreateSiteForm organizationId={client.dbId} availableApps={availableApps} /> : null}
      </div>

      {apps.length === 0 ? (
        <article className="card">
          <p className="card-muted">No apps yet. Create the first app for this client.</p>
          <p style={{ margin: "0.5rem 0 0", fontSize: "0.88rem" }}>
            <Link href="/apps" className="action-link">
              Open app directory <ArrowRightIcon className="btn-icon" />
            </Link>
          </p>
        </article>
      ) : (
        <SiteDirectoryView
          userId={session?.user?.id}
          isCollaboratorView={!canManageClient}
          sites={apps.map((app) => ({
            id: app.id,
            name: app.name,
            description: app.description,
            clientId: client.id,
            clientName: client.name,
            status: app.status,
            ownershipState: app.ownershipState,
            ownershipDiagnostic: app.ownershipDiagnostic,
            source: app.source,
            href: `/apps/${app.slug ?? app.id}`,
            clientHref: `/clients/${clientId}`,
            resourceType: app.resourceType,
            showInternalMetadata: canManageClient,
            isStagingResource:
              app.coolifyEnvironmentName?.toLowerCase().includes("staging")
              || app.name.toLowerCase().includes("staging")
              || app.slug?.toLowerCase().includes("staging")
              || false
          }))}
        />
      )}
    </div>
  );
}
