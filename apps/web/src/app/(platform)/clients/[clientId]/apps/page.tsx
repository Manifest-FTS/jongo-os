import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth.config";
import { getClientWorkspace, getSiteWorkspace, isClientAdmin, listSiteDirectory } from "@/lib/repositories";
import CreateSiteForm from "@/components/CreateSiteForm";
import { ArrowRightIcon } from "@/components/JongoIcons";
import { getCoolifyOverview } from "@/lib/coolify";
import { buildAvailableCoolifyAppOptions } from "@/lib/coolify-app-picker";
import ClientAppsView, { type ClientAppRow } from "@/components/ClientAppsView";
import { buildTemporaryProductionDomain } from "@/lib/temporary-domains";
import { isPlatformAdminUser } from "@/lib/rbac";

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
  const canAdopt = Boolean(session?.user?.id && (await isPlatformAdminUser(session.user.id)));

  const rows = await buildAppRows(apps, overview);

  return (
    <div className="page-stack">
      <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "flex-start", flexWrap: "wrap" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: "1.25rem" }}>Apps</h2>
          <p className="card-muted" style={{ margin: "0.25rem 0 0" }}>
            {rows.length === 0 ? "Nothing deployed for this client yet." : `${rows.length} app${rows.length === 1 ? "" : "s"} for ${client.name}.`}
          </p>
        </div>
        {client.dbId && showCreate ? (
          <CreateSiteForm
            organizationId={client.dbId}
            availableApps={canAdopt ? availableApps : []}
            githubOnly={!canManageClient}
            githubAvailable={githubAvailable}
            canAdopt={canAdopt}
            presentation="drawer"
          />
        ) : null}
      </div>

      {githubReturn ? (
        <p className={`m-0 px-3.5 py-2.5 rounded-lg text-[13px] border border-solid ${githubReturn.ok ? "bg-healthy-bg border-healthy-border text-healthy-text" : "bg-warn-bg border-warn-border text-warn-text"}`}>
          {githubReturn.text}
        </p>
      ) : null}

      <ClientAppsView rows={rows} userId={session?.user?.id} canCreate={Boolean(client.dbId && showCreate)} />
    </div>
  );
}

type DirectoryApp = Awaited<ReturnType<typeof listSiteDirectory>>[number];

/**
 * What each row shows: the live address (what hosting serves, else the
 * temporary one), the repository and branch, the last production deploy, and
 * whether a deploy is running right now. One query per table, not per app.
 */
async function buildAppRows(apps: DirectoryApp[], overview: Awaited<ReturnType<typeof getCoolifyOverview>> | null): Promise<ClientAppRow[]> {
  const ids = apps.map((app) => app.id).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  const { db } = await import("@/lib/db");
  const [sites, deployments, running] = ids.length
    ? await Promise.all([
        db.site.findMany({
          where: { id: { in: ids } },
          select: { id: true, slug: true, temporaryDomainSlug: true, temporaryDomainSuffix: true, gitRepoFullName: true, gitRepositoryUrl: true, gitBranch: true, gitProvider: true, coolifyServiceUuid: true }
        }),
        db.deployment.findMany({
          where: { environment: { siteId: { in: ids }, name: "production" } },
          orderBy: { triggeredAt: "desc" },
          take: 500,
          select: { status: true, triggeredAt: true, finishedAt: true, environment: { select: { siteId: true } } }
        }),
        db.operation.findMany({
          where: { kind: "site.deploy", resourceType: "site", resourceId: { in: ids }, status: { in: ["queued", "running"] } },
          select: { resourceId: true }
        })
      ]).catch(() => [[], [], []] as [any[], any[], any[]])
    : [[], [], []];

  const siteById = new Map<string, any>(sites.map((site: any) => [site.id, site]));
  const lastDeploy = new Map<string, any>();
  for (const deployment of deployments as any[]) {
    const siteId = deployment.environment?.siteId;
    if (siteId && !lastDeploy.has(siteId)) lastDeploy.set(siteId, deployment);
  }
  const deploying = new Set((running as any[]).map((row) => row.resourceId));

  return apps.map((app) => {
    const site = siteById.get(app.id);
    const live = overview?.sites.find((item) => item.id === (site?.coolifyServiceUuid ?? app.coolifyServiceUuid) || item.deployTargetId === app.deployTargetId);
    const temporary = buildTemporaryProductionDomain({ slug: site?.temporaryDomainSlug ?? site?.slug ?? app.slug ?? app.name, suffix: site?.temporaryDomainSuffix });
    const domain = (live?.primaryDomain ?? "").replace(/^https?:\/\//, "").replace(/\/.*$/, "") || temporary || null;
    const repo = site?.gitRepoFullName || (site?.gitRepositoryUrl ? site.gitRepositoryUrl.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "") : null);
    const deploy = lastDeploy.get(app.id);
    const siteType = live?.siteType ?? (app.resourceType === "WordPress" ? "wordpress" : undefined);
    return {
      id: app.id,
      href: `/apps/${app.slug ?? app.id}`,
      name: app.name,
      kind: siteType === "wordpress" ? "wordpress" : siteType === "database" ? "database" : siteType === "service" ? "service" : "app",
      status: app.status,
      deploying: deploying.has(app.id),
      domain,
      repo,
      provider: (site?.gitProvider as ClientAppRow["provider"]) ?? (site?.gitRepositoryUrl?.includes("github.com") ? "github" : null),
      branch: site?.gitBranch ?? null,
      lastDeployAt: deploy ? (deploy.finishedAt ?? deploy.triggeredAt)?.toISOString?.() ?? null : null,
      lastDeployFailed: deploy?.status === "failed"
    } satisfies ClientAppRow;
  });
}
