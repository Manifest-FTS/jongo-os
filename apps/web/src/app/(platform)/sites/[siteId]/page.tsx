import { getCoolifyOverview } from "@/lib/coolify";
import { getCoolifyAppBackupInventory, AppBackupInventory } from "@/lib/coolify";
import { getActivityFeedEmptyMessage } from "@/lib/reason-messages";
import { getDeployLockReason } from "@/lib/deploy-guards";
import DeployButton from "@/components/DeployButton";
import { getSiteActivityFeed, getSiteWorkspace, isClientAdmin } from "@/lib/repositories";
import Link from "next/link";
import { ArrowRightIcon } from "@/components/JongoIcons";
import PendingBadge from "@/components/PendingBadge";
import { auth } from "@/lib/auth.config";
import { notFound } from "next/navigation";

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
    return { state: "not_configured", detail: "Critical configuration is missing." };
  }
  if (checks.some((check) => check.state === "attention")) {
    return { state: "attention", detail: "Some operational signals need follow-up." };
  }
  if (checks.every((check) => check.state === "unknown")) {
    return { state: "unknown", detail: "Telemetry is unavailable, so readiness cannot be confirmed." };
  }
  if (checks.every((check) => check.state === "ready" || check.state === "unknown")) {
    return { state: "ready", detail: "Core operational checks are in a healthy state." };
  }

  return { state: "unknown", detail: "Readiness status is mixed and inconclusive." };
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
  const lastSuccessfulBackup = getLastSuccessfulBackupTime(backupInventory);
  const recentBackupHealthy = lastSuccessfulBackup ? isRecentBackup(lastSuccessfulBackup, 7) : false;
  const stagingConfigured = Boolean(workspace?.stagingEnabled && site?.stagingStatus && site.stagingStatus !== "unknown");
  const isWordPress = workspace?.siteType === "wordpress";
  const deployLockReason = getDeployLockReason(backupInventory, workspace?.coolifyServiceUuid);

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
      key: "staging",
      label: "Staging configured",
      state: stagingConfigured ? "ready" : workspace?.stagingEnabled ? "attention" : "not_configured",
      detail: stagingConfigured
        ? "Staging is configured and has status telemetry."
        : workspace?.stagingEnabled
          ? "Staging flag is enabled but live staging status is unavailable."
          : "Staging is not configured for this app.",
      nextStep: "Configure staging environment mapping in app settings."
    },
    {
      key: "domain-resolving",
      label: "Domain resolving",
      state: "unknown",
      detail: "Domain DNS resolution checks are not yet wired to provider DNS telemetry.",
      nextStep: "Verify DNS A/CNAME records in your domain provider and Coolify."
    },
    {
      key: "ssl",
      label: "SSL healthy",
      state: "unknown",
      detail: "SSL certificate status checks are not yet available in this view.",
      nextStep: "Confirm TLS certificate validity in Coolify domain settings."
    },
    {
      key: "deploy-health",
      label: "Deploy health",
      state: site?.productionStatus === "healthy"
        ? "ready"
        : site?.productionStatus === "unknown"
          ? "unknown"
          : "attention",
      detail: site?.productionStatus
        ? `Production deployment status is ${site.productionStatus}.`
        : "No deployment status was found for this app.",
      nextStep: "Review recent deployment logs and resolve failed deploys."
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
    },
    {
      key: "app-status",
      label: "App runtime status",
      state: site?.status === "healthy"
        ? "ready"
        : site?.status === "unknown" || !site
          ? "unknown"
          : "attention",
      detail: site?.status
        ? `Current app status is ${site.status}.`
        : "App status is unavailable in current inventory.",
      nextStep: "Open deploy and runtime diagnostics to inspect app health signals."
    }
  ];
  const readinessSummary = summarizeReadiness(readinessChecks);

  return (
    <div>
      <div className="grid" style={{ marginBottom: "1rem" }}>
        <article className="card" style={{ gridColumn: "1 / -1" }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
            <div>
              <h3 className="card-title" style={{ marginTop: 0 }}>Operational Readiness</h3>
              <p className="card-muted" style={{ margin: "0.35rem 0 0" }}>
                Read-only operational signals for production readiness. No actions here trigger deployments.
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

          <details style={{ marginTop: "0.8rem" }}>
            <summary style={{ cursor: "pointer", fontSize: "0.8rem", color: "var(--muted)" }}>Developer Details</summary>
            <p style={{ margin: "0.45rem 0 0", fontSize: "0.78rem", color: "var(--muted)" }}>
              Source mode: {overview.mode} · Coolify fetch error: {overview.fetchError ? "yes" : "no"} · Backup source: {backupInventory?.source ?? "none"}
            </p>
          </details>
        </article>

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
                disabled={Boolean(deployLockReason)}
                disabledReason={deployLockReason ?? undefined}
              />
              <DeployButton
                siteId={siteId}
                deployTargetId={site?.deployTargetId}
                environment="staging"
                disabled={Boolean(deployLockReason)}
                disabledReason={deployLockReason ?? undefined}
              />
            </div>
          ) : (
            <div className="diagnostic-banner" style={{ marginTop: "0.85rem" }}>
              <strong>Staging not configured.</strong> Deploy and sync actions stay hidden until this app has a real staging environment.
            </div>
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
            <p className="card-muted">Staging is not configured yet, so publishing workflow actions are hidden.</p>
          )}
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

      {/* WordPress context - shown only when site type is detected as WordPress */}
      {isWordPress && (
        <div style={{ marginBottom: "1rem" }}>
          <article className="card">
            <h3 className="card-title" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              WordPress Overview
              <span className="status-chip unknown" style={{ fontSize: "0.7rem" }}>WP detected</span>
              <PendingBadge reason="WordPress REST API is not yet connected. Add WP_API_URL to site environment variables to unlock live version, plugin, and maintenance data." />
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
                <p className="card-muted" style={{ margin: 0 }}>Enable WP API settings to control maintenance mode</p>
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
          <p className="card-muted">Protect site data with routine backups.</p>
          <p style={{ margin: "0.35rem 0", fontSize: "0.9rem" }}>
            Configure schedule and retention in site settings.
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
          <h3 className="card-title">Need Infrastructure Details?</h3>
          <p className="card-muted" style={{ marginBottom: 0 }}>
            Use the Advanced tab for diagnostics and provider-level metadata.
          </p>
        </article>
      ) : null}
    </div>
  );
}

