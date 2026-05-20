type Params = { params: Promise<{ siteId: string }> };

import DeployButton from "@/components/DeployButton";
import SiteInfoForm from "@/components/SiteInfoForm";
import Link from "next/link";
import { getSiteWorkspace, isClientAdmin } from "@/lib/repositories";
import { getCoolifyOverview, getCoolifyAppBackupInventory } from "@/lib/coolify";
import { getBackupReadiness } from "@/lib/deploy-guards";
import { auth } from "@/lib/auth.config";
import { notFound } from "next/navigation";

function formatAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default async function SiteSettingsPage({ params }: Params) {
  const { siteId } = await params;
  const session = await auth();
  const viewer = {
    userId: session?.user?.id,
    email: session?.user?.email
  };

  const [workspace, overview] = await Promise.all([
    getSiteWorkspace(siteId, viewer),
    getCoolifyOverview()
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
  const stagingConfigured = Boolean(workspace?.stagingEnabled && site?.stagingStatus && site.stagingStatus !== "unknown");
  const backupInventory = workspace?.coolifyServiceUuid
    ? await getCoolifyAppBackupInventory(workspace.coolifyServiceUuid)
    : null;
  const backupReadiness = getBackupReadiness(backupInventory, workspace?.coolifyServiceUuid);
  const deployLockReason = backupReadiness.locked
    ? `${backupReadiness.reason ?? "Action locked."} ${backupReadiness.nextStep ?? ""}`.trim()
    : "Dry-run mode: execution remains disabled in this interface.";

  return (
    <div>
      <div className="card" style={{ marginBottom: "1rem" }}>
        <p className="card-muted" style={{ marginBottom: "0.35rem" }}>
          {workspace?.clientName ?? "Unassigned client"} / {workspace?.name ?? siteId}
        </p>
        <h2 style={{ margin: 0 }}>Settings</h2>
        <p className="card-muted" style={{ marginTop: "0.35rem" }}>
          Manage publishing and app configuration.
        </p>
      </div>

      {/* Site Record (DB-backed sites only) */}
      {workspace?.source === "db" && (
        <article className="card" style={{ marginBottom: "1.5rem" }}>
          <h3 className="card-title">Site Information</h3>
          <p className="card-muted" style={{ marginBottom: "1rem" }}>Update name, description, and infrastructure links.</p>
          <SiteInfoForm
            siteId={siteId}
            initial={{
              name: workspace.name,
              description: workspace.description,
              coolifyServiceUuid: workspace.coolifyServiceUuid,
              coolifyProjectId: workspace.coolifyProjectId,
              stagingEnabled: workspace.stagingEnabled,
              gitRepositoryUrl: workspace.gitRepositoryUrl
            }}
          />
        </article>
      )}

      {canViewInternalMetadata && workspace?.ownershipState !== "mapped" && (
        <div className="diagnostic-banner" style={{ marginBottom: "1rem" }}>
          <strong>Ownership mapping needs attention.</strong> Map a Coolify Project ID in Site Information to avoid orphaned resources.
        </div>
      )}

      {/* Staging */}
      <article className="card" style={{ marginBottom: "1.5rem" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" }}>
          <div>
            <h3 className="card-title" style={{ margin: 0 }}>Staging Environment</h3>
            <p className="card-muted" style={{ margin: "0.35rem 0 0" }}>
              {stagingConfigured
                ? "Staging is enabled. Validate changes before promoting to production."
                : "Staging is not configured for this app yet."}
            </p>
          </div>
          <span className={`status-chip ${stagingConfigured ? "healthy" : "unknown"}`}>
            {stagingConfigured ? "Enabled" : "Not configured"}
          </span>
        </div>
        {stagingConfigured ? (
          <p style={{ margin: "0.75rem 0 0", fontSize: "0.9rem" }}>
            <Link href={`/apps/${siteId}/staging`} className="action-link">Open Staging workspace →</Link>
          </p>
        ) : (
          <p className="card-muted" style={{ margin: "0.75rem 0 0" }}>
            Deploy and sync controls remain hidden until staging is detected.
          </p>
        )}
      </article>

      {/* Publishing Actions */}
      <article className="card" style={{ marginBottom: "1.5rem" }}>
        <h3 className="card-title">Publishing Actions</h3>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem" }}>
          <DeployButton
            siteId={siteId}
            deployTargetId={site?.deployTargetId ?? workspace?.deployTargetId}
            environment="staging"
            label="Sync to Staging"
            disabled
            disabledReason={stagingConfigured
              ? deployLockReason
              : "Staging is not configured. Next step: enable staging and confirm Coolify staging detection."}
          />
          <DeployButton
            siteId={siteId}
            deployTargetId={site?.deployTargetId ?? workspace?.deployTargetId}
            environment="production"
            label="Deploy to Production"
            disabled
            disabledReason={deployLockReason}
          />
        </div>
        <p className="card-muted" style={{ marginTop: "0.75rem", marginBottom: 0 }}>
          Actions are intentionally dry-run only in this interface.
        </p>
      </article>

      {/* App Health */}
      <article className="card" style={{ marginBottom: "1.5rem" }}>
        <h3 className="card-title">App Health</h3>
        <div style={{ display: "grid", gap: "0.45rem", marginTop: "0.5rem" }}>
          <p style={{ margin: 0, fontSize: "0.9rem" }}>
            Overall: <span className={`status-chip ${workspace?.status ?? "unknown"}`}>{workspace?.status ?? "unknown"}</span>
          </p>
          <p style={{ margin: 0, fontSize: "0.9rem" }}>
            Production: <span className={`status-chip ${workspace?.productionStatus ?? "unknown"}`}>{workspace?.productionStatus ?? "unknown"}</span>
          </p>
          {stagingConfigured ? (
            <p style={{ margin: 0, fontSize: "0.9rem" }}>
              Staging: <span className={`status-chip ${workspace?.stagingStatus ?? "unknown"}`}>{workspace?.stagingStatus ?? "unknown"}</span>
            </p>
          ) : (
            <p style={{ margin: 0, fontSize: "0.9rem" }}>
              Staging: <span className="status-chip unknown">not configured</span>
            </p>
          )}
          {canViewInternalMetadata ? (
            <p style={{ margin: 0, fontSize: "0.9rem" }}>
              Ownership: <span className="tag">{workspace?.ownershipState ?? "unavailable"}</span>
            </p>
          ) : null}
        </div>
      </article>

      {/* Developer Details (replaces standalone Advanced tab) */}
      {canViewInternalMetadata ? (
      <details style={{ marginBottom: "1.5rem" }}>
        <summary
          style={{
            cursor: "pointer",
            padding: "0.85rem 1rem",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "10px",
            fontWeight: 600,
            fontSize: "0.9rem",
            userSelect: "none"
          }}
        >
          Developer Details
        </summary>
        <article className="card" style={{ marginTop: "0.5rem" }}>
          <p className="card-muted" style={{ marginBottom: "0.75rem" }}>
            Infrastructure identifiers and diagnostic values. For admin use.
          </p>
          <div style={{ display: "grid", gap: "0.4rem", fontSize: "0.88rem" }}>
            <p style={{ margin: 0 }}>App data source: <code>{workspace?.source ?? "unknown"}</code></p>
            <p style={{ margin: 0 }}>
              Coolify data: <code>{overview.mode}</code>{" "}
              <span style={{ color: "var(--muted)", fontSize: "0.8rem" }}>· fetched {formatAgo(overview.generatedAt)}</span>
            </p>
            {overview.fetchError ? (
              <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--muted)" }}>
                Coolify last error: <code>{overview.fetchError}</code>
              </p>
            ) : null}
            <p style={{ margin: 0 }}>Source: <code>{workspace?.source ?? "unknown"}</code></p>
            <p style={{ margin: 0 }}>Ownership: <code>{workspace?.ownershipState ?? "unavailable"}</code></p>
            {workspace?.coolifyServiceUuid ? (
              <p style={{ margin: 0 }}>Coolify UUID: <code>{workspace.coolifyServiceUuid}</code></p>
            ) : null}
            {workspace?.coolifyProjectId ? (
              <p style={{ margin: 0 }}>Coolify Project ID: <code>{workspace.coolifyProjectId}</code></p>
            ) : null}
            {workspace?.coolifyEnvironmentName ? (
              <p style={{ margin: 0 }}>Coolify Environment: <code>{workspace.coolifyEnvironmentName}</code></p>
            ) : null}
            {workspace?.gitRepositoryUrl ? (
              <p style={{ margin: 0 }}>Repository: <code>{workspace.gitRepositoryUrl}</code></p>
            ) : null}
          </div>
        </article>
      </details>
      ) : null}
    </div>
  );
}
