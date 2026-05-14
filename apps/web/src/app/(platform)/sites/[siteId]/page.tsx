import { getCoolifyOverview } from "@/lib/coolify";
import DeployButton from "@/components/DeployButton";
import { getSiteActivityFeed, getSiteWorkspace } from "@/lib/repositories";

type Params = { params: Promise<{ siteId: string }> };

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

export default async function SiteOverviewPage({ params }: Params) {
  const { siteId } = await params;
  const [overview, workspace, siteActivity] = await Promise.all([
    getCoolifyOverview(),
    getSiteWorkspace(siteId),
    getSiteActivityFeed(siteId)
  ]);
  const site = overview.sites.find((item) => item.id === siteId);
  const siteDeployments = overview.deployments.filter((deployment) => deployment.siteName === site?.name);
  const isWordPress = workspace?.siteType === "wordpress";

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Overview</h2>

      <div className="grid" style={{ marginBottom: "1rem" }}>
        {/* Health Summary */}
        <article className="card">
          <h3 className="card-title">Health Status</h3>
          <p style={{ margin: "0.35rem 0" }}>
            Production:{" "}
            <span className={`status-chip ${site?.productionStatus ?? "unknown"}`}>
              {site?.productionStatus ?? "unknown"}
            </span>
          </p>
          <p style={{ margin: "0.35rem 0" }}>
            Staging:{" "}
            <span className={`status-chip ${site?.stagingStatus ?? "unknown"}`}>
              {site?.stagingStatus ?? "unknown"}
            </span>
          </p>
          <p style={{ margin: "0.35rem 0" }}>
            Overall:{" "}
            <span className={`status-chip ${site?.status ?? "unknown"}`}>
              {site?.status ?? "unknown"}
            </span>
          </p>
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.85rem" }}>
            <DeployButton siteId={siteId} deployTargetId={site?.deployTargetId} environment="production" />
            <DeployButton siteId={siteId} deployTargetId={site?.deployTargetId} environment="staging" />
          </div>
        </article>

        {/* Collaborators */}
        <article className="card">
          <h3 className="card-title">Collaborators</h3>
          <p className="card-muted">Manage in Settings tab</p>
          <p style={{ margin: "0.35rem 0", fontSize: "0.9rem" }}>
            Team members and access control configured per-site
          </p>
        </article>

        {/* Recent Deployments */}
        <article className="card">
          <h3 className="card-title">Recent Deployments</h3>
          <p className="card-muted">
            {siteDeployments.length === 0 ? "No deployment records yet" : `${siteDeployments.length} recorded for this site`}
          </p>
          <p style={{ margin: "0.35rem 0", fontSize: "0.9rem" }}>
            <a href={`/sites/${siteId}/deployments`} style={{ color: "var(--accent)" }}>
              View deployment history â†’
            </a>
          </p>
        </article>
      </div>

      {/* WordPress Context â€” shown only when site type is detected as WordPress */}
      {isWordPress && (
        <div style={{ marginBottom: "1rem" }}>
          <article className="card">
            <h3 className="card-title" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              WordPress Operational Context
              <span className="status-chip unknown" style={{ fontSize: "0.7rem" }}>WP detected</span>
            </h3>
            <div className="grid" style={{ marginTop: "0.5rem" }}>
              <div>
                <p style={{ margin: "0.25rem 0", fontSize: "0.85rem", fontWeight: 500 }}>Core Version</p>
                <p className="card-muted" style={{ margin: 0 }}>Connect WordPress REST API to show version</p>
              </div>
              <div>
                <p style={{ margin: "0.25rem 0", fontSize: "0.85rem", fontWeight: 500 }}>Plugin Updates</p>
                <p className="card-muted" style={{ margin: 0 }}>Connect WordPress REST API to show pending updates</p>
              </div>
              <div>
                <p style={{ margin: "0.25rem 0", fontSize: "0.85rem", fontWeight: 500 }}>Maintenance Mode</p>
                <p className="card-muted" style={{ margin: 0 }}>Configure WP_API_URL in site settings to enable</p>
              </div>
            </div>
            <p style={{ margin: "0.75rem 0 0", fontSize: "0.8rem", color: "var(--muted)" }}>
              Add <code>WP_API_URL</code> to site environment variables to unlock WordPress operational data.
            </p>
          </article>
        </div>
      )}

      <div style={{ display: "grid", gap: "1rem", marginBottom: "1rem" }}>
        <article className="card">
          <h3 className="card-title">Activity Feed</h3>
          {siteActivity.length === 0 ? (
            <p className="card-muted" style={{ marginBottom: 0 }}>
              No activity yet. New deployment and staging events will appear here.
            </p>
          ) : (
            <div style={{ marginTop: "0.5rem", display: "grid", gap: "0.55rem" }}>
              {siteActivity.map((item) => (
                <div
                  key={item.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    paddingBottom: "0.5rem",
                    borderBottom: "1px solid var(--border)"
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ margin: 0, fontSize: "0.9rem", fontWeight: 500 }}>{item.title}</p>
                    <p style={{ margin: "0.2rem 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>
                      {item.detail}
                      {item.durationSeconds !== undefined && ` â€¢ ${formatDuration(item.durationSeconds)}`}
                      {item.timestamp ? ` â€¢ ${new Date(item.timestamp).toLocaleString()}` : ""}
                    </p>
                  </div>
                  <div style={{ display: "flex", gap: "0.35rem", marginLeft: "0.75rem", flexShrink: 0 }}>
                    {item.environment && item.environment !== "unknown" && (
                      <span className="status-chip unknown" style={{ fontSize: "0.72rem" }}>{item.environment}</span>
                    )}
                    <span className={`status-chip ${item.status}`}>{item.status}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </article>
      </div>

      <div className="grid">
        {/* Backup Status */}
        <article className="card">
          <h3 className="card-title">Backups</h3>
          <p className="card-muted">Configure in Settings</p>
          <p style={{ margin: "0.35rem 0", fontSize: "0.9rem" }}>
            Backup scheduling and retention managed per-site
          </p>
        </article>

        {/* Environment Configuration */}
        <article className="card">
          <h3 className="card-title">Environments</h3>
          <p style={{ margin: "0.35rem 0", fontSize: "0.9rem" }}>
            Production, Staging, Development
          </p>
          <p style={{ fontSize: "0.9rem" }}>
            <a href={`/sites/${siteId}/settings`} style={{ color: "var(--accent)" }}>
              Configure environments â†’
            </a>
          </p>
        </article>

        {/* Action Panel */}
        <article className="card">
          <h3 className="card-title">Quick Actions</h3>
          <p style={{ margin: "0.35rem 0", fontSize: "0.9rem" }}>
            <a href={`/sites/${siteId}/deployments`} style={{ color: "var(--accent)" }}>
              â€¢ Deploy now
            </a>
          </p>
          <p style={{ margin: "0.35rem 0", fontSize: "0.9rem" }}>
            <a href={`/sites/${siteId}/staging`} style={{ color: "var(--accent)" }}>
              â€¢ Sync staging
            </a>
          </p>
          <p style={{ margin: "0.35rem 0", fontSize: "0.9rem" }}>
            <a href={`/sites/${siteId}/settings`} style={{ color: "var(--accent)" }}>
              â€¢ Configure site
            </a>
          </p>
        </article>
      </div>
    </div>
  );
}

