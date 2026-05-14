import { getCoolifyOverview } from "@/lib/coolify";
import DeployButton from "@/components/DeployButton";
import { getSiteActivityFeed } from "@/lib/repositories";

type Params = { params: Promise<{ siteId: string }> };

export default async function SiteOverviewPage({ params }: Params) {
  const { siteId } = await params;
  const overview = await getCoolifyOverview();
  const site = overview.sites.find((item) => item.id === siteId);
  const siteDeployments = overview.deployments.filter((deployment) => deployment.siteName === site?.name);
  const siteActivity = await getSiteActivityFeed(siteId);

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
            {siteDeployments.length === 0 ? "No deployment records yet" : `${siteDeployments.length} total for this site`}
          </p>
          <p style={{ margin: "0.35rem 0", fontSize: "0.9rem" }}>
            <a href={`/sites/${siteId}/deployments`} style={{ color: "var(--accent)" }}>
              View deployment history →
            </a>
          </p>
        </article>
      </div>

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
                    alignItems: "center",
                    paddingBottom: "0.5rem",
                    borderBottom: "1px solid var(--border)"
                  }}
                >
                  <div>
                    <p style={{ margin: 0, fontSize: "0.9rem" }}>{item.title}</p>
                    <p style={{ margin: "0.25rem 0 0", fontSize: "0.85rem", color: "var(--muted)" }}>
                      {item.detail}
                      {item.timestamp ? ` • ${new Date(item.timestamp).toLocaleString()}` : ""}
                    </p>
                  </div>
                  <span className={`status-chip ${item.status}`}>{item.status}</span>
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
              Configure environments →
            </a>
          </p>
        </article>

        {/* Action Panel */}
        <article className="card">
          <h3 className="card-title">Action Panel</h3>
          <p style={{ margin: "0.35rem 0", fontSize: "0.9rem" }}>
            <a href={`/sites/${siteId}/deployments`} style={{ color: "var(--accent)" }}>
              • Deploy now
            </a>
          </p>
          <p style={{ margin: "0.35rem 0", fontSize: "0.9rem" }}>
            <a href={`/sites/${siteId}/staging`} style={{ color: "var(--accent)" }}>
              • Sync staging
            </a>
          </p>
        </article>
      </div>
    </div>
  );
}
