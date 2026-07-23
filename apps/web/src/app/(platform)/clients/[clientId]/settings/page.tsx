import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth.config";
import { getClientWorkspace, isClientAdmin } from "@/lib/repositories";
import { getCoolifyOverview } from "@/lib/coolify";
import CoolifyProjectMappingForm from "@/components/CoolifyProjectMappingForm";
import DeleteClientButton from "@/components/DeleteClientButton";

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
  const linkedProjects = client.linkedCoolifyProjects ?? [];

  const [isAdmin, overview] = await Promise.all([
    client.dbId && session?.user?.id ? isClientAdmin(client.dbId, session.user.id) : Promise.resolve(false),
    getCoolifyOverview()
  ]);

  if (!isAdmin) {
    redirect(`/clients/${clientId}`);
  }

  return (
    <div className="page-stack">
      <article className="card">
        <h3 className="card-title">Project Mapping</h3>
        <p className="card-muted" style={{ marginBottom: "1rem" }}>
          Link one or more projects to this client workspace. Project links are explicit and never auto-renamed.
        </p>
        {linkedProjects.length === 0 ? (
          <div className="diagnostic-banner" style={{ marginBottom: "1rem" }}>
            <strong>No linked project.</strong> Link at least one project so this client's apps map cleanly in Jongo.
          </div>
        ) : null}
        {client.dbId ? (
          <CoolifyProjectMappingForm
            organizationDbId={client.dbId}
            organizationName={client.name}
            availableProjects={overview.projects.map((project) => ({ id: project.id, name: project.name }))}
          />
        ) : (
          <p className="card-muted">Database-backed organization record is required to update mapping.</p>
        )}
        <div style={{ marginTop: "1rem" }}>
          <DeleteClientButton organizationId={client.dbId ?? client.id} />
        </div>
      </article>
    </div>
  );
}
