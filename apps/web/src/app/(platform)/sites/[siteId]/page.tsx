import { getCoolifyOverview } from "@/lib/coolify";
import { getCoolifyAppBackupInventory, getCoolifyAppStagingCapability, AppBackupInventory } from "@/lib/coolify";
import { getActivityFeedEmptyMessage } from "@/lib/reason-messages";
import { getBackupReadiness } from "@/lib/deploy-guards";
import { buildBackupReadModelSnapshot } from "@/lib/backup-read-model";
import DeployButton from "@/components/DeployButton";
import { getSiteActivityFeed, getSiteWorkspace, isClientAdmin } from "@/lib/repositories";
import Link from "next/link";
import { ArrowRightIcon } from "@/components/JongoIcons";
import { auth } from "@/lib/auth.config";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ siteId: string }> };

type ReadinessState = "ready" | "attention" | "not_configured" | "unknown";

type ReadinessCheck = {
  key: string;
  label: string;
  state: ReadinessState;
  detail: string;
  nextStep?: string;
};

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function formatAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function getLastSuccessfulBackupTime(inventory: AppBackupInventory | null): string | null {
  if (!inventory?.recentExecutions?.length) return null;
  const successful = inventory.recentExecutions.find((item) => item.status === "success" && item.finishedAt);
  return successful?.finishedAt ?? null;
}

function isRecentBackup(iso: string, maxAgeDays = 7): boolean {
  const ageMs = Date.now() - new Date(iso).getTime();
  return ageMs <= maxAgeDays * 24 * 60 * 60 * 1000;
}

function chipClassForReadiness(state: ReadinessState): string {
  if (state === "ready") return "healthy";
  if (state === "attention") return "degraded";
  if (state === "not_configured") return "error";
  return "unknown";
}

function labelForReadiness(state: ReadinessState): string {
  if (state === "ready") return "Ready";
  if (state === "attention") return "Needs attention";
  if (state === "not_configured") return "Not configured";
  return "Unknown";
}

function summarizeReadiness(checks: ReadinessCheck[]): { state: ReadinessState; detail: string } {
  if (checks.some((check) => check.state === "not_configured")) {
    return { state: "not_configured", detail: "Core Jongo configuration still needs setup." };
  }
  if (checks.some((check) => check.state === "attention")) {
    return { state: "attention", detail: "A maintenance checkpoint needs follow-up." };
  }
  if (checks.every((check) => check.state === "unknown")) {
    return { state: "unknown", detail: "Maintenance telemetry is unavailable, so readiness cannot be confirmed." };
  }
  if (checks.every((check) => check.state === "ready" || check.state === "unknown")) {
    return { state: "ready", detail: "Core Jongo-managed checkpoints are in a healthy state." };
  }

  return { state: "unknown", detail: "Checkpoint status is mixed and inconclusive." };
}

function getResourceWorkflowModel(siteType?: string): { title: string; body: string; bullets: string[] } {
  if (siteType === "wordpress") {
    return {
      title: "WordPress clone-style staging (future)",
      body: "WordPress workflows will follow clone-style staging for safe plugin, theme, content, and update validation.",
      bullets: [
        "Create Staging from Production",
        "Sync Production to Staging",
        "Push Staging to Production",
        "Admin/operator-controlled execution with backup readiness gates"
      ]
    };
  }

  if (siteType === "database") {
    return {
      title: "Database readiness model",
      body: "Database resources prioritize backup, restore, and readiness safety instead of website-style staging.",
      bullets: [
        "Backup health and freshness",
        "Restore validation readiness",
        "No website-style staging controls"
      ]
    };
  }

  if (siteType === "service") {
    return {
      title: "Service operations model",
      body: "Service resources prioritize runtime health and recovery workflows over staging-site clone flows.",
      bullets: [
        "Health, restart, and logs readiness",
        "Stateful safety checks where applicable",
        "No website-style staging controls by default"
      ]
    };
  }

  return {
    title: "Web app preview-style staging (future)",
    body: "Web app workflows should behave like preview deployments tied to branches/PRs, not clone-style WordPress staging.",
    bullets: [
      "Branch/PR preview environments",
      "Temporary preview URLs",
      "Pre-merge validation before main deployment",
      "Execution remains dry-run/disabled in this phase"
    ]
  };
}

export default async function SiteOverviewPage({ params }: Params) {
  const { siteId } = await params;
  const session = await auth();
  const viewer = {
    userId: session?.user?.id,
    email: session?.user?.email
  };

  const [overview, workspace, siteActivity] = await Promise.all([
    getCoolifyOverview(),
    getSiteWorkspace(siteId, viewer),
    getSiteActivityFeed(siteId, 6, viewer)
  ]);

  if (!workspace) {
    notFound();
  }
  const canViewInternalMetadata = Boolean(
    session?.user?.id &&
    workspace.organizationId &&
    await isClientAdmin(workspace.organizationId, session.user.id)
  );
  const coolifyId = workspace?.coolifyServiceUuid ?? siteId;
  const site = overview.sites.find((item) => item.id === coolifyId || item.deployTargetId === coolifyId);
  const backupInventory = workspace?.coolifyServiceUuid
    ? await getCoolifyAppBackupInventory(workspace.coolifyServiceUuid)
    : null;
  const stagingCapability = workspace?.coolifyServiceUuid
    ? await getCoolifyAppStagingCapability(workspace.coolifyServiceUuid, workspace?.coolifyProjectId ?? undefined)
    : null;
  const backupReadiness = getBackupReadiness(backupInventory, workspace?.coolifyServiceUuid);
  const backupLockReason = backupReadiness.locked
    ? `${backupReadiness.reason ?? "Action locked."} ${backupReadiness.nextStep ?? ""}`.trim()
    : "Dry-run mode: execution remains disabled in this interface.";
  const lastSuccessfulBackup = getLastSuccessfulBackupTime(backupInventory);
  const recentBackupHealthy = lastSuccessfulBackup ? isRecentBackup(lastSuccessfulBackup, 7) : false;
  const backupLocalStatus = backupInventory?.source !== "live"
    ? "Status unknown"
    : backupInventory.configured
      ? (recentBackupHealthy ? "Protected (recent)" : "Protected (stale)")
      : "Not protected";
  const backupReadModel = buildBackupReadModelSnapshot({
    ownership: `${workspace.clientName} / ${workspace.name}`,
    localStatus: backupLocalStatus,
    schedules: backupInventory?.schedules.filter((schedule) => schedule.enabled)
  });
  const stagingEnvironmentReady = Boolean(stagingCapability?.detected);
  const stagingTargetAttached = Boolean(stagingCapability?.applicationUuid);
  const stagingConfigured = Boolean(workspace?.stagingEnabled && stagingEnvironmentReady && stagingTargetAttached);
  const workflowModel = getResourceWorkflowModel(workspace?.siteType);

  const readinessChecks: ReadinessCheck[] = [
    {
      key: "backup-configured",
      label: "Backups configured",
      state: !workspace?.coolifyServiceUuid
        ? "not_configured"
        : backupInventory?.source !== "live"
          ? "unknown"
          : backupInventory?.configured
            ? "ready"
            : "not_configured",
      detail: !workspace?.coolifyServiceUuid
        ? "No Coolify app UUID is linked to this app."
        : backupInventory?.source !== "live"
          ? "Could not reach live backup inventory from Coolify."
          : backupInventory?.configured
            ? "At least one active database backup schedule is present."
            : "No active backup schedules were found.",
      nextStep: "Open Backups and configure recurring schedules in Coolify."
    },
    {
      key: "recent-backup",
      label: "Recent backup",
      state: backupInventory?.source !== "live"
        ? "unknown"
        : !lastSuccessfulBackup
          ? "attention"
          : recentBackupHealthy
            ? "ready"
            : "attention",
      detail: backupInventory?.source !== "live"
        ? "Recent execution history is unavailable."
        : !lastSuccessfulBackup
          ? "No successful backup was found in recent execution history."
          : recentBackupHealthy
            ? `Last successful backup was ${formatAgo(lastSuccessfulBackup)}.`
            : `Last successful backup was ${formatAgo(lastSuccessfulBackup)}, which exceeds 7 days.`,
      nextStep: "Investigate backup failures and run a fresh successful backup."
    },
    {
      key: "offsite-replication",
      label: "Offsite replication",
      state: backupReadModel.offsite.tone === "healthy"
        ? "ready"
        : backupReadModel.offsite.tone === "degraded"
          ? "attention"
          : "unknown",
      detail: backupReadModel.offsite.detail,
      nextStep: "Enable and verify offsite replication policy for protected backups."
    },
    {
      key: "staging",
      label: "Staging configured",
      state: stagingConfigured ? "ready" : workspace?.stagingEnabled ? "attention" : "not_configured",
      detail: stagingConfigured
        ? "Staging environment and target are both attached."
        : workspace?.stagingEnabled && stagingEnvironmentReady
          ? "Staging environment exists but no staging target is attached yet."
          : workspace?.stagingEnabled
            ? "Staging is enabled but no staging environment is detected in Coolify."
          : "Staging is not configured for this app.",
      nextStep: "Configure staging environment mapping in app settings."
    },
    {
      key: "coolify-api",
      label: "Coolify API reachable",
      state: overview.mode === "live" ? (overview.fetchError ? "attention" : "ready") : "unknown",
      detail:
        overview.mode === "live"
          ? overview.fetchError
            ? "Coolify API is configured but recent fetch returned errors."
            : "Coolify API is configured and telemetry is updating."
          : "Coolify API is not configured (mock mode).",
      nextStep: "Verify COOLIFY_API_BASE_URL and COOLIFY_API_TOKEN runtime env values."
    }
  ];
  const readinessSummary = summarizeReadiness(readinessChecks);

  return (
    <div>
      <div className="grid" style={{ marginBottom: "1rem" }}>
        

        {/* Site Health */}
        <article className="card">
          <h3 className="card-title">Site Health</h3>
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
          <p style={{ margin: "0.35rem 0", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <span className={`status-chip ${stagingEnvironmentReady ? "healthy" : "unknown"}`}>
              {stagingEnvironmentReady ? "Environment created" : "Environment missing"}
            </span>
            <span className={`status-chip ${stagingTargetAttached ? "healthy" : "degraded"}`}>
              {stagingTargetAttached ? "Target attached" : "Target missing"}
            </span>
          </p>
          <p style={{ margin: "0.35rem 0" }}>
            Overall:{" "}
            <span className={`status-chip ${site?.status ?? "unknown"}`}>
              {site?.status ?? "unknown"}
            </span>
          </p>
          {stagingConfigured ? (
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.85rem" }}>
              <DeployButton
                siteId={siteId}
                deployTargetId={site?.deployTargetId}
                environment="production"
                disabled
                disabledReason={backupLockReason}
              />
              <DeployButton
                siteId={siteId}
                deployTargetId={site?.deployTargetId}
                environment="staging"
                disabled
                disabledReason={backupLockReason}
              />
            </div>
          ) : (
            <p className="card-muted" style={{ marginTop: "0.75rem", marginBottom: 0 }}>
              {workspace?.stagingEnabled && stagingEnvironmentReady
                ? "Staging environment exists, but no target is attached yet. Attach a staging target in Coolify, then refresh this page."
                : "Staging controls are hidden until a staging environment is configured. Configure staging in Settings."}
            </p>
          )}
          <p style={{ margin: "0.55rem 0 0", fontSize: "0.75rem", color: "var(--muted)" }}>
            {overview.mode === "live"
              ? <>Live telemetry · {formatAgo(overview.generatedAt)}{overview.fetchError && <span style={{ color: "var(--error, #c0392b)", marginLeft: "0.3rem" }}>· unavailable</span>}</>
              : "Demo mode — live telemetry requires provider config"}
          </p>
        </article>

        {/* Publishing */}
        <article className="card">
          <h3 className="card-title">Publishing</h3>
          {stagingConfigured ? (
            <>
              <p className="card-muted">Move changes safely from staging to production.</p>
              <p style={{ margin: "0.75rem 0 0", fontSize: "0.9rem" }}>
                Use staging sync for review, then promote when ready.
              </p>
              <p style={{ margin: "0.75rem 0 0" }}>
                <Link href={`/apps/${siteId}/staging`} className="action-link">
                  Open publishing workflow <ArrowRightIcon className="btn-icon" />
                </Link>
              </p>
            </>
          ) : (
            <p className="card-muted">
              {workspace?.stagingEnabled && stagingEnvironmentReady
                ? "Staging environment exists but target attachment is incomplete. Complete target attachment in Coolify, then continue in Staging."
                : "Staging is not configured yet. Configure it in Settings to unlock staging workflows."}
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

        <article className="card">
          <h3 className="card-title">Team</h3>
          <p className="card-muted">Team management lives in the dedicated Team tab.</p>
          <p style={{ margin: "0.75rem 0 0" }}>
            <Link href={`/apps/${siteId}/team`} className="action-link">
              Open app team <ArrowRightIcon className="btn-icon" />
            </Link>
          </p>
        </article>
      </div>

      <article className="card" style={{ gridColumn: "1 / -1" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
          <div>
            <h3 className="card-title" style={{ marginTop: 0 }}>Operational Readiness</h3>
            <p className="card-muted" style={{ margin: "0.35rem 0 0" }}>
              Read-only Jongo checkpoints for backup, staging, and provider readiness. No actions here trigger deployments.
            </p>
          </div>
          <span className={`status-chip ${chipClassForReadiness(readinessSummary.state)}`}>
            {labelForReadiness(readinessSummary.state)}
          </span>
        </div>

        <p style={{ margin: "0.6rem 0 0", fontSize: "0.88rem", color: "var(--muted)" }}>
          {readinessSummary.detail}
        </p>

        <div style={{ display: "grid", gap: "0.7rem", marginTop: "0.85rem" }}>
          {readinessChecks.map((check) => (
            <div key={check.key} style={{ border: "1px solid var(--border)", borderRadius: "8px", padding: "0.65rem 0.75rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                <strong style={{ fontSize: "0.9rem" }}>{check.label}</strong>
                <span className={`status-chip ${chipClassForReadiness(check.state)}`}>{labelForReadiness(check.state)}</span>
              </div>
              <p style={{ margin: "0.35rem 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>{check.detail}</p>
              {check.state !== "ready" && check.nextStep ? (
                <p style={{ margin: "0.3rem 0 0", fontSize: "0.8rem" }}>
                  <strong>Next step:</strong> {check.nextStep}
                </p>
              ) : null}
            </div>
          ))}
        </div>

        {canViewInternalMetadata ? (
          <p style={{ margin: "0.75rem 0 0", fontSize: "0.84rem", color: "var(--muted)" }}>
            Need deeper troubleshooting? Open app settings for maintenance details or platform diagnostics.
          </p>
        ) : null}
      </article>

      <div style={{ display: "grid", gap: "1rem", marginBottom: "1rem" }}>
        <article className="card">
          <h3 className="card-title">Activity Feed</h3>
          {siteActivity.length === 0 ? (
            <p className="card-muted" style={{ marginBottom: 0 }}>
              {getActivityFeedEmptyMessage(!site, Boolean(overview.fetchError))}
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
                      {item.durationSeconds !== undefined && ` - ${formatDuration(item.durationSeconds)}`}
                      {item.timestamp ? ` - ${new Date(item.timestamp).toLocaleString()}` : ""}
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
        {/* Backups */}
        <article className="card">
          <h3 className="card-title">Backups</h3>
          <p className="card-muted">Read-model summary for backup posture in this app workspace.</p>
          <div style={{ display: "grid", gap: "0.35rem", marginTop: "0.55rem" }}>
            <p style={{ margin: 0, fontSize: "0.86rem" }}>
              Layer: <strong>{backupReadModel.layerType}</strong>
            </p>
            <p style={{ margin: 0, fontSize: "0.86rem" }}>
              Local status: <strong>{backupReadModel.localStatus}</strong>
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: "0.45rem", flexWrap: "wrap" }}>
              <p style={{ margin: 0, fontSize: "0.86rem" }}>Offsite:</p>
              <span className={`status-chip ${backupReadModel.offsite.tone}`}>{backupReadModel.offsite.label}</span>
            </div>
            <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--muted)" }}>{backupReadModel.offsite.detail}</p>
            <p style={{ margin: 0, fontSize: "0.86rem" }}>
              Restore scope: <strong>{backupReadModel.restoreScope}</strong>
            </p>
            <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--muted)" }}>
              Staging safety: {backupReadModel.stagingSafety}. {backupReadModel.stagingSafetyDetail}
            </p>
          </div>
          <p style={{ margin: "0.7rem 0 0", fontSize: "0.9rem" }}>
            <Link href={`/apps/${siteId}/backups`} className="action-link">
              Open backup details <ArrowRightIcon className="btn-icon" />
            </Link>
          </p>
        </article>

        {/* Environments */}
        <article className="card">
          <h3 className="card-title">Environments</h3>
          <p style={{ margin: "0.35rem 0", fontSize: "0.9rem" }}>
            Production, Staging, Development
          </p>
          {stagingConfigured ? (
            <p style={{ fontSize: "0.9rem" }}>
              <Link href={`/apps/${siteId}/settings`} className="action-link">
                Configure environments <ArrowRightIcon className="btn-icon" />
              </Link>
            </p>
          ) : (
            <p className="card-muted" style={{ marginBottom: 0 }}>Staging configuration is required before environment actions are shown.</p>
          )}
        </article>

        {/* Next Steps */}
        <article className="card">
          <h3 className="card-title">What to do next</h3>
          <p style={{ margin: "0.35rem 0", fontSize: "0.9rem" }}>
            <Link href={`/apps/${siteId}/analytics`} className="action-link">
              Review deployment analytics <ArrowRightIcon className="btn-icon" />
            </Link>
          </p>
          <p style={{ margin: "0.35rem 0", fontSize: "0.9rem" }}>
            {stagingConfigured ? (
              <Link href={`/apps/${siteId}/staging`} className="action-link">
                Run publishing workflow <ArrowRightIcon className="btn-icon" />
              </Link>
            ) : (
              <span className="card-muted">Publishing workflow is hidden until staging is configured.</span>
            )}
          </p>
          <p style={{ margin: "0.35rem 0", fontSize: "0.9rem" }}>
            <Link href={`/apps/${siteId}/settings`} className="action-link">
              Update site settings <ArrowRightIcon className="btn-icon" />
            </Link>
          </p>
        </article>
      </div>

      {canViewInternalMetadata ? (
        <article className="card" style={{ marginTop: "1rem" }}>
          <h3 className="card-title">Need Maintenance Details?</h3>
          <p className="card-muted" style={{ marginBottom: "0.6rem" }}>
            Use settings for mapping and provider linkage checks.
          </p>
          <p style={{ margin: 0, fontSize: "0.9rem" }}>
            <Link href={`/apps/${siteId}/settings`} className="action-link">
              Open app settings <ArrowRightIcon className="btn-icon" />
            </Link>
          </p>
        </article>
      ) : null}
    </div>
  );
}

