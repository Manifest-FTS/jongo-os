import DeployButton from "@/components/DeployButton";
import { getCoolifyOverview } from "@/lib/coolify";
import { getSiteWorkspace, listSiteDeployments } from "@/lib/repositories";

type Params = { params: Promise<{ siteId: string }> };

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function envLabel(env: string) {
  if (env === "production") return "Production";
  if (env === "staging") return "Staging";
  return env;
}

function statusTone(status: string): string {
  if (status === "success" || status === "healthy") return "healthy";
  if (status === "failed" || status === "error") return "error";
  if (status === "in_progress" || status === "degraded") return "degraded";
  return "unknown";
}

export default async function AnalyticsPage({ params }: Params) {
  const { siteId } = await params;
  const [overview, workspace, deployments] = await Promise.all([
    getCoolifyOverview(),
    getSiteWorkspace(siteId),
    listSiteDeployments(siteId)
  ]);

  const coolifyId = workspace?.coolifyServiceUuid ?? siteId;
  const site = overview.sites.find((item) => item.id === coolifyId || item.deployTargetId === coolifyId);

  const productionDeployments = deployments.filter((d) => d.environment === "production");
  const stagingDeployments = deployments.filter((d) => d.environment === "staging");

  return (
    <div className="page-stack">
      <section className="metric-strip">
        <article className="card metric-card">
          <p className="metric-value">{deployments.length}</p>
          <p className="metric-label">Total Deploys</p>
        </article>
        <article className="card metric-card">
          <p className="metric-value">{productionDeployments.length}</p>
          <p className="metric-label">Production</p>
        </article>
        <article className="card metric-card">
          <p className="metric-value">{stagingDeployments.length}</p>
          <p className="metric-label">Staging</p>
        </article>
      </section>

      <section className="grid" style={{ marginBottom: "1rem" }}>
        <article className="card">
          <h3 className="card-title">Current Status</h3>
          <p style={{ margin: "0.35rem 0" }}>
            Production: <span className={`status-chip ${site?.productionStatus ?? "unknown"}`}>{site?.productionStatus ?? "unknown"}</span>
          </p>
          <p style={{ margin: "0.35rem 0" }}>
            Staging: <span className={`status-chip ${site?.stagingStatus ?? "unknown"}`}>{site?.stagingStatus ?? "unknown"}</span>
          </p>
        </article>

        <article className="card">
          <h3 className="card-title">Quick Actions</h3>
          <div style={{ display: "grid", gap: "0.65rem", marginTop: "0.75rem" }}>
            <DeployButton siteId={siteId} deployTargetId={site?.deployTargetId} environment="production" label="Deploy to Production" />
            <DeployButton siteId={siteId} deployTargetId={site?.deployTargetId} environment="staging" label="Sync to Staging" />
          </div>
        </article>
      </section>

      <article className="card">
        <h3 className="card-title">Deployment Timeline</h3>
        {deployments.length === 0 ? (
          <p className="card-muted" style={{ marginTop: "0.75rem" }}>No deployments recorded yet.</p>
        ) : (
          <div className="deploy-timeline" style={{ marginTop: "1rem" }}>
            {deployments.map((deployment) => (
              <div key={deployment.id} className="deploy-row">
                <div className="deploy-row-indicator">
                  <span className={`deploy-dot ${statusTone(deployment.status)}`} />
                </div>
                <div className="deploy-row-body">
                  <div className="deploy-row-head">
                    <span className="deploy-env-label">{envLabel(deployment.environment)}</span>
                    <span className="deploy-time">{formatRelativeTime(deployment.triggeredAt)}</span>
                    <span className={`status-chip ${statusTone(deployment.status)}`}>{deployment.status.replace("_", " ")}</span>
                  </div>
                  {deployment.commitMessage ? <p className="deploy-commit">{deployment.commitMessage}</p> : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </article>
    </div>
  );
}
