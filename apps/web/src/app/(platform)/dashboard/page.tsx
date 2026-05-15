import { getCoolifyOverview } from "@/lib/coolify";
import { getActivityFeed, listClientWorkspaces } from "@/lib/repositories";
import { auth } from "@/lib/auth.config";

export default async function DashboardPage() {
  const session = await auth();
  const email = session?.user?.email ?? "";
  const greeting = email ? email.split("@")[0] : "there";

  const overview = await getCoolifyOverview();
  const clients = await listClientWorkspaces({
    userId: session?.user?.id,
    email: session?.user?.email
  });
  const activityFeed = await getActivityFeed();
  const wordpressSites = overview.sites.filter((site) => site.siteType === "wordpress");
  const totalSites = Math.max(overview.sites.length, 1);
  const healthBars = [
    { label: "Healthy", value: overview.stats.healthySites, tone: "healthy" },
    { label: "Degraded", value: overview.stats.degradedSites, tone: "degraded" },
    { label: "Error", value: overview.stats.errorSites, tone: "error" }
  ];

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
          <p className="metric-value">{overview.sites.length}</p>
          <p className="metric-label">Sites</p>
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
          <p className="metric-value">{overview.stats.healthySites}</p>
          <p className="metric-label">Healthy</p>
        </article>
      </section>

      <section className="dashboard-shell">
        <article className="card dashboard-health-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Site health</p>
              <h2 className="card-title">Operational health</h2>
            </div>
            <span className="status-chip healthy">{overview.stats.healthySites}/{overview.sites.length || 0} healthy</span>
          </div>

          <div className="health-summary-grid">
            {healthBars.map((item) => (
              <div key={item.label} className="health-stat-block">
                <p className={`health-stat-value ${item.tone}`}>{item.value}</p>
                <p className="health-stat-label">{item.label}</p>
              </div>
            ))}
          </div>

          <div className="health-bars">
            {healthBars.map((item) => (
              <div key={item.label} className="health-bar-row">
                <div className="health-bar-meta">
                  <span>{item.label}</span>
                  <span>{Math.round((item.value / totalSites) * 100)}%</span>
                </div>
                <div className="health-bar-track">
                  <span className={`health-bar-fill ${item.tone}`} style={{ width: `${Math.max((item.value / totalSites) * 100, item.value > 0 ? 8 : 0)}%` }} />
                </div>
              </div>
            ))}
          </div>

          {wordpressSites.length > 0 ? (
            <div className="dashboard-inline-note">
              <span className="tag">WordPress footprint</span>
              <span className="card-muted">{wordpressSites.length} WordPress site{wordpressSites.length === 1 ? "" : "s"} in this workspace.</span>
            </div>
          ) : null}
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
                <h2 className="card-title">Plugin status</h2>
              </div>
            </div>
            <div className="health-summary-grid two-up">
              <div className="health-stat-block">
                <p className="metric-value small">{wordpressSites.length}</p>
                <p className="metric-label">WordPress sites</p>
              </div>
              <div className="health-stat-block">
                <p className="metric-value small">n/a</p>
                <p className="metric-label">Updates pending</p>
              </div>
              <div className="health-stat-block">
                <p className="metric-value small">n/a</p>
                <p className="metric-label">Vulnerabilities</p>
              </div>
            </div>
            <p className="card-muted">Plugin telemetry is not connected yet, so this panel is scoped to WordPress footprint only.</p>
          </article>
        </section>
      ) : null}
    </div>
  );
}
