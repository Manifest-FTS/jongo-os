import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth.config";
import { getClientWorkspace, getSiteWorkspace, isClientAdmin, listSiteDirectory } from "@/lib/repositories";
import CreateSiteForm from "@/components/CreateSiteForm";
import { ArrowRightIcon } from "@/components/JongoIcons";
import { getCoolifyOverview } from "@/lib/coolify";
import { buildAvailableCoolifyAppOptions } from "@/lib/coolify-app-picker";
import SiteDirectoryView from "@/components/SiteDirectoryView";

type Params = { params: Promise<{ clientId: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> };

/** What happened when the person came back from GitHub's connect pages. */
const GITHUB_RETURN: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "GitHub is connected. Use Add App → Deploy from GitHub to pick a repo." },
  requested: { ok: true, text: "GitHub sent an approval request to your GitHub organization's owners. It connects here as soon as one approves it." },
  in_use: { ok: false, text: "That GitHub account is already connected to another client in Jongo." },
  link_expired: { ok: false, text: "That connect link expired. Try Connect GitHub again." },
  wrong_user: { ok: false, text: "Finish connecting while signed in as the person who started it." },
  not_allowed: { ok: false, text: "Your role on this client can't connect GitHub." },
  bad_owner: { ok: false, text: "That GitHub organization name isn't valid." },
  missing_install: { ok: false, text: "GitHub didn't say which installation to connect. Try again." },
  failed: { ok: false, text: "Couldn't finish connecting GitHub. Try again." }
};

export default async function ClientAppsPage({ params, searchParams }: Params) {
  const { clientId } = await params;
  const query = (await searchParams) ?? {};
  const githubKey = Array.isArray(query.github) ? query.github[0] : query.github;
  const githubReturn = githubKey ? GITHUB_RETURN[githubKey] ?? null : null;
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
  // Connecting GitHub creates the client's own GitHub App when needed, so it is
  // always available to the client's team.
  const githubAvailable = true;
  const showCreate = true;

  return (
    <div className="page-stack">
      <div className="card" style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "center" }}>
        <div>
          <h2 style={{ margin: 0 }}>Apps</h2>
          <p className="card-muted" style={{ marginTop: "0.35rem" }}>All apps mapped to this client workspace.</p>
        </div>
        {client.dbId && showCreate ? <CreateSiteForm organizationId={client.dbId} availableApps={availableApps} githubOnly={!canManageClient} githubAvailable={githubAvailable} /> : null}
      </div>

      {githubReturn ? (
        <p className={`m-0 px-3.5 py-2.5 rounded-lg text-[13px] border border-solid ${githubReturn.ok ? "bg-healthy-bg border-healthy-border text-healthy-text" : "bg-warn-bg border-warn-border text-warn-text"}`}>
          {githubReturn.text}
        </p>
      ) : null}

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
