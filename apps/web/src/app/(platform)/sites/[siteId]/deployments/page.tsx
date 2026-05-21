import DeployButton from "@/components/DeployButton";
import { getCoolifyOverview, getCoolifyAppBackupInventory } from "@/lib/coolify";
import { getBackupReadiness } from "@/lib/deploy-guards";
import { getSiteWorkspace, listSiteDeployments } from "@/lib/repositories";
import { auth } from "@/lib/auth.config";
import { notFound } from "next/navigation";

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

export default async function DeploymentsPage({ params }: Params) {
  const { siteId } = await params;
  const session = await auth();
  const viewer = {
    userId: session?.user?.id,
    email: session?.user?.email
  };

  const [overview, workspace, deployments] = await Promise.all([
    getCoolifyOverview(),
    getSiteWorkspace(siteId, viewer),
    listSiteDeployments(siteId, viewer)
  ]);

  if (!workspace) {
    notFound();
  }
  const coolifyId = workspace?.coolifyServiceUuid ?? siteId;
  const site = overview.sites.find((item) => item.id === coolifyId || item.deployTargetId === coolifyId);
  const stagingConfigured = Boolean(workspace?.stagingEnabled && site?.stagingStatus && site.stagingStatus !== "unknown");
  const backupInventory = workspace?.coolifyServiceUuid
    ? await getCoolifyAppBackupInventory(workspace.coolifyServiceUuid)
    : null;
  const backupReadiness = getBackupReadiness(backupInventory, workspace?.coolifyServiceUuid);
  const deployLockReason = backupReadiness.locked
    ? `${backupReadiness.reason ?? "Action locked."} ${backupReadiness.nextStep ?? ""}`.trim()
    : "Dry-run mode: execution remains disabled in this interface.";

  const productionDeployments = deployments.filter((d) => d.environment === "production");
  const stagingDeployments = deployments.filter((d) => d.environment === "staging");
  const lastSuccess = deployments.find((d) => d.status === "success" || d.status === "healthy");

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
        <article className="card metric-card">
          <p className="metric-value" style={{ fontSize: "1rem" }}>
            {lastSuccess ? formatRelativeTime(lastSuccess.triggeredAt) : "—"}
          </p>
          <p className="metric-label">Last Success</p>
        </article>
      </section>

      <section className="grid" style={{ marginBottom: "1rem" }}>
        <article className="card">
          <h3 className="card-title">Current Status</h3>
          <div style={{ display: "grid", gap: "0.45rem", marginTop: "0.5rem" }}>
            <p style={{ margin: 0 }}>
              Production:{" "}
              <span className={`status-chip ${site?.productionStatus ?? "unknown"}`}>
                {site?.productionStatus ?? "unknown"}
              </span>
            </p>
            <p style={{ margin: 0 }}>
              Staging:{" "}
              <span className={`status-chip ${site?.stagingStatus ?? "unknown"}`}>
                {site?.stagingStatus ?? "unknown"}
              </span>
            </p>
          </div>
        </article>

        <article className="card">
          <h3 className="card-title">Quick Actions</h3>
          {stagingConfigured ? (
            <>
              <div style={{ display: "grid", gap: "0.65rem", marginTop: "0.75rem" }}>
                <DeployButton
                  siteId={siteId}
                  deployTargetId={site?.deployTargetId}
                  environment="production"
                  label="Deploy to Production"
                  disabled
                  disabledReason={deployLockReason}
                />
                <DeployButton
                  siteId={siteId}
                  deployTargetId={site?.deployTargetId}
                  environment="staging"
                  label="Sync to Staging"
                  disabled
                  disabledReason={deployLockReason}
                />
              </div>
              <p className="card-muted" style={{ marginTop: "0.75rem", marginBottom: 0 }}>
                Actions are intentionally dry-run only in this interface.
              </p>
            </>
          ) : (
            <p className="card-muted" style={{ marginTop: "0.75rem", marginBottom: 0 }}>
              Staging is not configured. Sync and promote controls appear here after staging is detected.
            </p>
          )}
        </article>
      </section>

      <article className="card">
        <div className="panel-header">
          <h3 className="card-title" style={{ margin: 0 }}>Deployment History</h3>
          <span className="tag">{deployments[0]?.source ?? overview.mode}</span>
        </div>

        {deployments.length === 0 ? (
          <p className="card-muted" style={{ marginTop: "0.75rem" }}>
            No deployments recorded yet. Trigger your first deploy above.
          </p>
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
                    {deployment.actor && (
                      <span className="deploy-actor">{deployment.actor}</span>
                    )}
                    <span className="deploy-time">{formatRelativeTime(deployment.triggeredAt)}</span>
                    <span className={`status-chip ${statusTone(deployment.status)}`}>{deployment.status.replace("_", " ")}</span>
                  </div>
                  {deployment.commitMessage && (
                    <p className="deploy-commit">{deployment.commitMessage}</p>
                  )}
                  {deployment.commitSha && (
                    <p className="deploy-sha">{deployment.commitSha.slice(0, 7)}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </article>
    </div>
  );
}
