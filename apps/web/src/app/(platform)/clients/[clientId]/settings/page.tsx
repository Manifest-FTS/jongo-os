import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth.config";
import { getClientWorkspace } from "@/lib/repositories";
import { resolveOrganizationAccess } from "@/lib/tenant-route-access";
import { getCoolifyOverview } from "@/lib/coolify";
import CoolifyProjectMappingForm from "@/components/CoolifyProjectMappingForm";
import DeleteClientButton from "@/components/DeleteClientButton";

type Params = {
  params: Promise<{ clientId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ClientSettingsPage({ params, searchParams }: Params) {
  const { clientId } = await params;
  const query = (await searchParams) ?? {};
  const githubReturn = Array.isArray(query.github) ? query.github[0] : query.github;
  const session = await auth();

  const client = await getClientWorkspace(clientId, {
    userId: session?.user?.id,
    email: session?.user?.email
  });

  if (!client) {
    notFound();
  }
  const linkedProjects = client.linkedCoolifyProjects ?? [];

  const access = client.dbId && session?.user?.id
    ? await resolveOrganizationAccess(client.dbId, session.user.id) : null;
  if (!access?.isAdmin) {
    redirect(`/clients/${clientId}`);
  }
  const overview = access.isPlatformAdmin ? await getCoolifyOverview() : null;

  return (
    <div className="page-stack">
      {client.dbId ? (
        <article className="card">
          <h3 className="card-title">GitHub</h3>
          <p className="card-muted mt-1 mb-2">GitHub Apps for private repositories are managed under Git sources.</p>
          <a className="action-link font-semibold" href={`/clients/${client.dbId}/sources${githubReturn ? `?github=${encodeURIComponent(githubReturn)}` : ""}`}>Open Git sources</a>
        </article>
      ) : null}
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
        {client.dbId && overview ? (
          <CoolifyProjectMappingForm
            organizationDbId={client.dbId}
            organizationName={client.name}
            availableProjects={overview.projects.map((project) => ({ id: project.id, name: project.name }))}
          />
        ) : (
          <p className="card-muted">A platform admin manages infrastructure project mapping.</p>
        )}
        <div style={{ marginTop: "1rem" }}>
          <DeleteClientButton organizationId={client.dbId ?? client.id} />
        </div>
      </article>
    </div>
  );
}
