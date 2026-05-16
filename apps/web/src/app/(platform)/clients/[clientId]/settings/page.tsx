import { notFound } from "next/navigation";
import { auth } from "@/lib/auth.config";
import { getClientWorkspace, isClientAdmin } from "@/lib/repositories";
import { getCoolifyOverview } from "@/lib/coolify";
import CoolifyProjectMappingForm from "@/components/CoolifyProjectMappingForm";

type Params = { params: Promise<{ clientId: string }> };

export default async function ClientSettingsPage({ params }: Params) {
  const { clientId } = await params;
  const session = await auth();

  const client = await getClientWorkspace(clientId, {
    userId: session?.user?.id,
    email: session?.user?.email
  });

  if (!client) {
    notFound();
  }

  const [isAdmin, overview] = await Promise.all([
    client.dbId && session?.user?.id ? isClientAdmin(client.dbId, session.user.id) : Promise.resolve(false),
    getCoolifyOverview()
  ]);

  return (
    <div className="page-stack">
      <article className="card">
        <h2 style={{ marginTop: 0 }}>Client Settings</h2>
        <p className="card-muted">Configuration and ownership mapping controls for this client workspace.</p>
      </article>

      {isAdmin ? (
        <article className="card">
          <h3 className="card-title">Coolify Project Mapping</h3>
          <p className="card-muted" style={{ marginBottom: "1rem" }}>
            Map this client to a Coolify project so related apps resolve ownership automatically.
          </p>
          {!client.coolifyProjectId ? (
            <div className="diagnostic-banner" style={{ marginBottom: "1rem" }}>
              <strong>No project mapped.</strong> Unmapped apps may appear orphaned in diagnostics.
            </div>
          ) : null}
          {client.dbId ? (
            <CoolifyProjectMappingForm
              organizationDbId={client.dbId}
              currentProjectId={client.coolifyProjectId}
              currentProjectName={client.coolifyProjectName}
              availableProjects={overview.projects.map((project) => ({ id: project.id, name: project.name }))}
            />
          ) : (
            <p className="card-muted">Database-backed organization record is required to update mapping.</p>
          )}
        </article>
      ) : (
        <article className="card">
          <h3 className="card-title">Admin-only Settings</h3>
          <p className="card-muted">Coolify ownership mapping is restricted to admin users.</p>
        </article>
      )}
    </div>
  );
}
