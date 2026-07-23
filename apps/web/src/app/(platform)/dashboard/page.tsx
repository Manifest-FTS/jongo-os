import Link from "next/link";
import { getActivityFeed, getInventorySnapshot, isClientAdmin, listClientWorkspaces } from "@/lib/repositories";
import { auth } from "@/lib/auth.config";
import { DayIcon, EveningIcon } from "@/components/JongoIcons";
import SiteDirectoryView from "@/components/SiteDirectoryView";

export const dynamic = "force-dynamic";

type FavoriteRow = { appId: string };

async function getFavoriteAppIds(userId?: string): Promise<string[]> {
  if (!userId) return [];

  try {
    const { getDb } = await import("@/lib/db");
    const prisma = await getDb();
    if (!prisma) return [];

    const rows = await prisma.$queryRaw<FavoriteRow[]>`
      SELECT "appId"
      FROM "UserFavoriteApp"
      WHERE "userId" = ${userId}::uuid
    `;

    return rows.map((row: FavoriteRow) => row.appId);
  } catch {
    return [];
  }
}

export default async function DashboardPage() {
  const session = await auth();
  const email = session?.user?.email ?? "";
  const rawDisplayName = (session?.user as { name?: string; fullName?: string } | undefined)?.name
    ?? (session?.user as { fullName?: string } | undefined)?.fullName
    ?? (email ? email.split("@")[0] : "there");
  const firstName = rawDisplayName.trim().split(/\s+/)[0] || "there";
  const hour = new Date().getHours();
  const isDaytime = hour >= 6 && hour < 18;
  const salutation = isDaytime ? "Good day" : "Good evening";

  const inventory = await getInventorySnapshot({
    userId: session?.user?.id,
    email: session?.user?.email
  });
  const overview = inventory.overview;
  const visibleSiteDirectory = inventory.siteDirectory;
  const clients = await listClientWorkspaces({
    userId: session?.user?.id,
    email: session?.user?.email
  });
  const activityFeed = await getActivityFeed(6, {
    userId: session?.user?.id,
    email: session?.user?.email
  });
  const visibleSitesByName = new Set(visibleSiteDirectory.map((site) => site.name.trim().toLowerCase()));
  const visibleOverviewSites = overview.sites.filter((site) => visibleSitesByName.has(site.name.trim().toLowerCase()));
  const wordpressSites = visibleOverviewSites.filter((site) => site.siteType === "wordpress");
  const healthySites = visibleSiteDirectory.filter((site) => site.status === "healthy").length;
  const unknownSites = visibleSiteDirectory.filter((site) => site.status === "unknown").length;
  const totalTeamMembers = clients.reduce((total, client) => total + client.memberCount, 0);
  const favoriteAppIds = await getFavoriteAppIds(session?.user?.id);
  const favoriteAppIdSet = new Set(favoriteAppIds);
  const starredApps = visibleSiteDirectory.filter((site) => favoriteAppIdSet.has(site.id));
  const uniqueClientDbIds = [...new Set(clients.map((client) => client.dbId).filter((id): id is string => Boolean(id)))];
  const adminChecks = session?.user?.id
    ? await Promise.all(uniqueClientDbIds.map((clientDbId) => isClientAdmin(clientDbId, session.user.id)))
    : [];
  const hasAdminClientAccess = adminChecks.some(Boolean);

  return (
    <div className="page-stack">
      <section className="page-head compact-head" style={{ marginTop: "1.1rem" }}>
        <div>
          <h1 className="page-title" style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
            {isDaytime ? <DayIcon style={{ width: "2.05rem", height: "2.05rem" }} /> : <EveningIcon style={{ width: "2.05rem", height: "2.05rem" }} />}
            <span>{salutation}, {firstName}</span>
          </h1>
          <p className="page-subtitle">Welcome to Jongo OS beta</p>
        </div>
      </section>

      <section className="metric-strip dashboard-metric-strip">
        <article className="card metric-card">
          <p className="metric-value">{visibleSiteDirectory.length}</p>
          <p className="metric-label">Apps</p>
        </article>
        <article className="card metric-card">
          <p className="metric-value">{clients.length}</p>
          <p className="metric-label">Clients</p>
        </article>
        <article className="card metric-card">
          <p className="metric-value">{totalTeamMembers}</p>
          <p className="metric-label">Team Members</p>
        </article>
        <article className="card metric-card">
          <p className="metric-value">{healthySites}</p>
          <p className="metric-label">Healthy</p>
        </article>
        {unknownSites > 0 && (
          <article className="card metric-card metric-card--compact">
            <p className="metric-value metric-value--muted">{unknownSites}</p>
            <p className="metric-label">Offline</p>
          </article>
        )}
      </section>

      <section className="dashboard-shell">
        <div className="page-stack">
          <article className="card dashboard-health-panel">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Site health</p>
                <h2 className="card-title">Workspace summary</h2>
              </div>
              <span className="status-chip healthy">{healthySites}/{visibleSiteDirectory.length || 0} healthy</span>
            </div>

            <p className="card-muted" style={{ marginTop: 0 }}>
              {healthySites} app{healthySites === 1 ? " is" : "s are"} healthy right now.
              {unknownSites > 0 ? ` ${unknownSites} app${unknownSites === 1 ? " is" : "s are"} offline or restarting.` : ""}
            </p>

            <p className="card-muted" style={{ marginBottom: 0 }}>
              Use the apps list for filters and the app pages for maintenance details.
            </p>

            <p style={{ margin: "0.75rem 0 0", fontSize: "0.88rem" }}>
              <Link href="/apps" className="action-link">Open apps list</Link>
            </p>
          </article>

          <section className="page-stack">
            <div>
              <p className="panel-kicker" style={{ margin: 0 }}>Quick access</p>
              <h2 className="card-title" style={{ margin: "0.2rem 0 0" }}>Favorite Apps</h2>
            </div>

            {starredApps.length === 0 ? (
              <article className="card">
                <p className="card-muted" style={{ marginTop: 0 }}>
                  Star apps from the Apps directory to pin them here.
                </p>
              </article>
            ) : (
              <SiteDirectoryView
                userId={session?.user?.id}
                isCollaboratorView={!hasAdminClientAccess}
                sites={starredApps.map((site) => ({
                  id: site.id,
                  name: site.name,
                  description: site.description,
                  clientId: site.clientId,
                  clientName: site.clientName,
                  status: site.status,
                  ownershipState: site.ownershipState,
                  ownershipDiagnostic: site.ownershipDiagnostic,
                  source: site.source,
                  href: `/apps/${site.slug ?? site.id}`,
                  clientHref: site.ownershipState === "mapped" ? `/clients/${site.clientId}` : undefined,
                  resourceType: site.resourceType,
                  showInternalMetadata: hasAdminClientAccess,
                  isStagingResource:
                    site.coolifyEnvironmentName?.toLowerCase().includes("staging")
                    || site.name.toLowerCase().includes("staging")
                    || site.slug?.toLowerCase().includes("staging")
                    || false
                }))}
              />
            )}
          </section>
        </div>

        <article className="card dashboard-activity-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Recent activity</p>
              <h2 className="card-title">Latest deployments</h2>
            </div>
          </div>

          {activityFeed.length === 0 ? (
            <p className="card-muted">No recent deployments.</p>
          ) : (
            <div className="activity-list compact">
              {activityFeed.slice(0, 6).map((item) => (
                <div key={item.id} className="activity-item">
                  <div className="activity-copy">
                    <p className="activity-title">{item.title}</p>
                    <p className="activity-detail">
                      {item.detail}
                      {item.durationSeconds !== undefined && ` - ${item.durationSeconds < 60 ? `${item.durationSeconds}s` : `${Math.floor(item.durationSeconds / 60)}m`}`}
                    </p>
                  </div>
                  <div className="activity-meta">
                    {item.environment && <span className="status-chip unknown">{item.environment}</span>}
                    <span className={`status-chip ${item.status}`}>{item.status}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </article>
      </section>

      {wordpressSites.length > 0 && hasAdminClientAccess ? (
        <section className="dashboard-secondary-grid">
          <article className="card dashboard-plugin-panel">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">WordPress</p>
                <h2 className="card-title">WordPress footprint</h2>
              </div>
            </div>
            <p className="card-muted">
              {wordpressSites.length} WordPress app{wordpressSites.length === 1 ? "" : "s"} are in this workspace.
              Plugin status details live on each app&apos;s Plugins page.
            </p>
            <p style={{ margin: "0.75rem 0 0", fontSize: "0.88rem" }}>
              <Link href="/apps" className="action-link">Open apps list</Link>
            </p>
          </article>
        </section>
      ) : null}
    </div>
  );
}
