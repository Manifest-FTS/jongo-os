import DeployButton from "@/components/DeployButton";
import { getCoolifyOverview, getCoolifyAppBackupInventory, getCoolifyAppStagingCapability } from "@/lib/coolify";
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

function getResourceWorkflowModel(siteType?: string): { title: string; body: string; bullets: string[] } {
  if (siteType === "wordpress") {
    return {
      title: "WordPress clone-style staging (future)",
      body: "WordPress workflows prioritize clone-style staging for plugin, theme, content, and update validation before production actions.",
      bullets: [
        "Create Staging from Production",
        "Sync Production to Staging",
        "Push Staging to Production",
        "Execution remains admin/operator-controlled and backup-gated"
      ]
    };
  }

  if (siteType === "database") {
    return {
      title: "Database operations model",
      body: "Database resources prioritize backup and restore readiness instead of website-style staging workflows.",
      bullets: [
        "Backup freshness and readiness",
        "Restore validation readiness",
        "No staging-site clone controls"
      ]
    };
  }

  if (siteType === "service") {
    return {
      title: "Service operations model",
      body: "Service resources focus on runtime health and recovery workflows over website-style staging controls.",
      bullets: [
        "Health, restart, and logs readiness",
        "Stateful safety checks where applicable",
        "No staging-site clone controls by default"
      ]
    };
  }

  return {
    title: "Web app preview-style model (future)",
    body: "Web app workflows should map to branch/PR preview deployments rather than clone-style staging.",
    bullets: [
      "Branch/PR preview environments",
      "Temporary preview URLs",
      "Pre-merge checks before main deployment",
      "Execution remains dry-run/disabled in this phase"
    ]
  };
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
  const stagingCapability = workspace?.coolifyServiceUuid
    ? await getCoolifyAppStagingCapability(workspace.coolifyServiceUuid, workspace?.coolifyProjectId ?? undefined)
    : null;
  const stagingEnvironmentReady = Boolean(stagingCapability?.detected);
  const stagingTargetAttached = Boolean(stagingCapability?.applicationUuid);
  const stagingConfigured = Boolean(workspace?.stagingEnabled && stagingEnvironmentReady && stagingTargetAttached);
  const backupInventory = workspace?.coolifyServiceUuid
    ? await getCoolifyAppBackupInventory(workspace.coolifyServiceUuid)
    : null;
  const backupReadiness = getBackupReadiness(backupInventory, workspace?.coolifyServiceUuid);
  const deployLockReason = backupReadiness.locked
    ? `${backupReadiness.reason ?? "Action locked."} ${backupReadiness.nextStep ?? ""}`.trim()
    : "Dry-run mode: execution remains disabled in this interface.";
  const workflowModel = getResourceWorkflowModel(workspace?.siteType);
  const latestDeployment = deployments[0];

  const lastSuccess = deployments.find((d) => d.status === "success" || d.status === "healthy");

  return (
    <div className="page-stack">
      <section className="metric-strip">
        <article className="card metric-card">
          <p className="metric-value">{deployments.length}</p>
          <p className="metric-label">Total Deploys</p>
        </article>
        <article className="card metric-card">
          <p className="metric-value" style={{ fontSize: "1rem" }}>
            {lastSuccess ? formatRelativeTime(lastSuccess.triggeredAt) : "—"}
          </p>
          <p className="metric-label">Last Success</p>
        </article>
        <article className="card metric-card">
          <p className="metric-value" style={{ fontSize: "1rem" }}>
            {latestDeployment ? formatRelativeTime(latestDeployment.triggeredAt) : "—"}
          </p>
          <p className="metric-label">Last Activity</p>
        </article>
      </section>

      <section className="grid" style={{ marginBottom: "1rem" }}>
        <article className="card">
          <h3 className="card-title">Deployment Readiness</h3>
          <p className="card-muted" style={{ marginBottom: "0.5rem" }}>
            {stagingConfigured
              ? "Staging is configured and deploy flow controls are available below."
              : workspace?.stagingEnabled && stagingEnvironmentReady
                ? "Staging environment exists, but no staging target is attached yet."
                : "Staging is not configured yet, so only production deploy flow is shown."}
          </p>
          <p style={{ margin: "0 0 0.5rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <span className={`status-chip ${stagingEnvironmentReady ? "healthy" : "unknown"}`}>
              {stagingEnvironmentReady ? "Environment created" : "Environment missing"}
            </span>
            <span className={`status-chip ${stagingTargetAttached ? "healthy" : "degraded"}`}>
              {stagingTargetAttached ? "Target attached" : "Target missing"}
            </span>
          </p>
          <p className="card-muted" style={{ margin: 0 }}>
            {backupReadiness.locked
              ? backupReadiness.reason ?? "Backup checks are currently blocking deploy actions."
              : "Backup checks are passing, but actions stay in dry-run mode in this phase."}
          </p>
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
              {workspace?.stagingEnabled && stagingEnvironmentReady
                ? "Staging environment exists, but target attachment is incomplete. Attach a staging target in Coolify to unlock sync and promote controls."
                : "Staging is not configured. Sync and promote controls appear here after staging is detected."}
            </p>
          )}
        </article>

        <article className="card">
          <h3 className="card-title">Resource Workflow Model</h3>
          <p className="card-muted" style={{ marginBottom: "0.5rem" }}>{workflowModel.body}</p>
          <span className="tag" style={{ marginBottom: "0.5rem", display: "inline-flex" }}>{workflowModel.title}</span>
          <ul style={{ margin: 0, paddingLeft: "1.15rem", display: "grid", gap: "0.25rem" }}>
            {workflowModel.bullets.map((item) => (
              <li key={item} style={{ fontSize: "0.85rem", color: "var(--muted)" }}>{item}</li>
            ))}
          </ul>
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
