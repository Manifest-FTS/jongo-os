import Link from "next/link";
import { getActivityFeed, getInventorySnapshot, listClientWorkspaces } from "@/lib/repositories";
import { auth } from "@/lib/auth.config";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await auth();
  const email = session?.user?.email ?? "";
  const greeting = email ? email.split("@")[0] : "there";

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

  return (
    <div className="page-stack">
      <section className="page-head compact-head">
        <div>
          <h1 className="page-title">Hello, {greeting}.</h1>
          <p className="page-subtitle">A tighter view of client ops, site health, and publishing activity.</p>
        </div>
      </section>

      <section className="metric-strip">
        <article className="card metric-card">
          <p className="metric-value">{visibleSiteDirectory.length}</p>
          <p className="metric-label">Apps</p>
        </article>
        <article className="card metric-card">
          <p className="metric-value">{clients.length}</p>
          <p className="metric-label">Clients</p>
        </article>
        <article className="card metric-card">
          <p className="metric-value">{overview.deployments.length}</p>
          <p className="metric-label">Deployments</p>
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

      {wordpressSites.length > 0 ? (
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
