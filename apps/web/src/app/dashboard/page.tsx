import { getCoolifyOverview } from "../../lib/coolify";

export default async function DashboardPage() {
  const overview = await getCoolifyOverview();

  return (
    <div>
      <div className="card" style={{ marginBottom: "1rem" }}>
        <p className="card-muted" style={{ marginBottom: "0.35rem" }}>Dashboard</p>
        <h1 style={{ margin: 0 }}>Jongo Dashboard</h1>
        <p className="card-muted" style={{ marginTop: "0.35rem" }}>
          Platform-level operations, activity, and infrastructure health.
        </p>
      </div>

      <section className="grid">
        {/* Platform Stats */}
        <article className="card">
          <h2 className="card-title">Platform Overview</h2>
          <div style={{ marginTop: "0.75rem" }}>
            <p style={{ margin: "0.35rem 0" }}>
              Total Sites: <strong>{overview.sites.length}</strong>
            </p>
            <p style={{ margin: "0.35rem 0" }}>
              Total Deployments: <strong>{overview.deployments.length}</strong>
            </p>
            <p style={{ margin: "0.35rem 0" }}>
              Data Source: <span className="tag" style={{ display: "inline" }}>{overview.mode}</span>
            </p>
          </div>
        </article>

        {/* Health Summary */}
        <article className="card">
          <h2 className="card-title">Infrastructure Health</h2>
          <div style={{ marginTop: "0.75rem" }}>
            <p style={{ margin: "0.35rem 0" }}>
              <span style={{ color: "var(--success, #10b981)" }}>●</span> Healthy:{" "}
              <strong>{overview.stats.healthySites}</strong>
            </p>
            <p style={{ margin: "0.35rem 0" }}>
              <span style={{ color: "var(--warning, #f59e0b)" }}>●</span> Degraded:{" "}
              <strong>{overview.stats.degradedSites}</strong>
            </p>
            <p style={{ margin: "0.35rem 0" }}>
              <span style={{ color: "var(--danger, #ef4444)" }}>●</span> Error:{" "}
              <strong>{overview.stats.errorSites}</strong>
            </p>
          </div>
        </article>

        {/* Sites Needing Attention */}
        <article className="card">
          <h2 className="card-title">Sites Needing Attention</h2>
          {overview.sites.filter((s) => s.status !== "healthy").length === 0 ? (
            <p className="card-muted">All sites are healthy</p>
          ) : (
            <div style={{ marginTop: "0.75rem" }}>
              {overview.sites
                .filter((s) => s.status !== "healthy")
                .map((site) => (
                  <p key={site.id} style={{ margin: "0.35rem 0" }}>
                    <strong>{site.name}</strong>{" "}
                    <span className={`status-chip ${site.status}`}>{site.status}</span>
                  </p>
                ))}
            </div>
          )}
        </article>

        {/* Quick Navigation */}
        <article className="card">
          <h2 className="card-title">Quick Navigation</h2>
          <div style={{ marginTop: "0.75rem" }}>
            <p style={{ margin: "0.35rem 0" }}>
              <a href="/sites" style={{ color: "var(--accent)", textDecoration: "none" }}>
                → View all sites
              </a>
            </p>
            <p style={{ margin: "0.35rem 0" }}>
              <a href="/organizations" style={{ color: "var(--accent)", textDecoration: "none" }}>
                → Manage clients
              </a>
            </p>
            <p style={{ margin: "0.35rem 0" }}>
              <a href="/settings" style={{ color: "var(--accent)", textDecoration: "none" }}>
                → Platform settings
              </a>
            </p>
          </div>
        </article>
      </section>

      {/* Recent Activity */}
      <section className="card" style={{ marginTop: "1rem" }}>
        <h2 className="card-title">Recent Deployment Activity</h2>
        {overview.deployments.length === 0 ? (
          <p className="card-muted">No recent deployments</p>
        ) : (
          <div style={{ marginTop: "1rem" }}>
            {overview.deployments.slice(0, 5).map((deployment) => (
              <div
                key={deployment.id}
                style={{
                  padding: "0.75rem",
                  marginBottom: "0.5rem",
                  background: "var(--bg-alt)",
                  borderRadius: "var(--radius)",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center"
                }}
              >
                <div>
                  <p style={{ margin: 0, fontWeight: 500 }}>
                    {deployment.siteName} → {deployment.environment}
                  </p>
                  {deployment.finishedAt && (
                    <p style={{ margin: "0.25rem 0 0", fontSize: "0.85rem", color: "var(--muted)" }}>
                      {new Date(deployment.finishedAt).toLocaleDateString()}
                    </p>
                  )}
                </div>
                <span className={`status-chip ${deployment.status}`}>{deployment.status}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
