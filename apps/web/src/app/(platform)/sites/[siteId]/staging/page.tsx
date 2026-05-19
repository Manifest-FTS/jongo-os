import { getCoolifyAppStagingCapability, buildStagingSyncDryRunPlan } from "@/lib/coolify";
import { getCoolifyAppBackupInventory } from "@/lib/coolify";
import { getStagingDetectionMessage } from "@/lib/reason-messages";
import { getDeployLockReason } from "@/lib/deploy-guards";
import DeployButton from "@/components/DeployButton";
import Link from "next/link";
import { getSiteWorkspace } from "@/lib/repositories";
import { auth } from "@/lib/auth.config";
import { notFound } from "next/navigation";

type Params = { params: Promise<{ siteId: string }> };

function formatAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default async function StagingPage({ params }: Params) {
  const { siteId } = await params;
  const session = await auth();
  const workspace = await getSiteWorkspace(siteId, {
    userId: session?.user?.id,
    email: session?.user?.email
  });

  if (!workspace) {
    notFound();
  }

  const stagingEnabled = Boolean(workspace?.stagingEnabled);
  const appUuid = workspace?.coolifyServiceUuid;
  const projectId = workspace?.coolifyProjectId;

  const [stagingCapability, backupInventory] = appUuid
    ? await Promise.all([
      getCoolifyAppStagingCapability(appUuid, projectId ?? undefined),
      getCoolifyAppBackupInventory(appUuid)
    ])
    : [null, null];
  const stagingConfigured = Boolean(stagingEnabled && stagingCapability?.detected);
  const deployLockReason = getDeployLockReason(backupInventory, appUuid);

  const dryRunPlan =
    stagingConfigured && appUuid && stagingCapability
      ? await buildStagingSyncDryRunPlan(appUuid, workspace?.name ?? siteId, stagingCapability)
      : null;

  return (
    <div className="page-stack">
      {/* Status header */}
      <article className="card">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 600 }}>Staging Environment</h2>
            <p style={{ margin: "0.25rem 0 0", fontSize: "0.85rem", color: "var(--muted)" }}>
              {stagingConfigured
                ? "Staging is active. Validate changes here before promoting to production."
                : "Staging is not configured for this site."}
            </p>
          </div>
          <span className={`status-chip ${stagingConfigured ? "healthy" : "unknown"}`}>
            {stagingConfigured ? "Enabled" : "Not configured"}
          </span>
        </div>
        {!stagingConfigured && (
          <p style={{ margin: "0.75rem 0 0", fontSize: "0.9rem" }}>
            Enable staging in <Link href={`/apps/${siteId}/settings`} className="action-link">Settings</Link> to manage staging workflows.
          </p>
        )}
      </article>

      {stagingConfigured ? (
        <>
          {/* Coolify Staging Capability */}
          <article className="card">
            <h3 className="card-title">Staging Capability</h3>
            {!appUuid ? (
              <p className="card-muted" style={{ marginBottom: 0 }}>
                No Coolify resource linked. Link a Coolify UUID in <Link href={`/apps/${siteId}/settings`} className="action-link">Settings</Link> to detect staging resources.
              </p>
            ) : !stagingCapability ? (
              <p className="card-muted" style={{ marginBottom: 0 }}>Staging capability could not be determined.</p>
            ) : stagingCapability.detected ? (
              <div style={{ display: "grid", gap: "0.4rem", marginTop: "0.5rem", fontSize: "0.88rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                  <span className="status-chip healthy">Detected</span>
                  {stagingCapability.environmentName && (
                    <span className="tag">{stagingCapability.environmentName}</span>
                  )}
                </div>
                {stagingCapability.applicationName && (
                  <p style={{ margin: 0 }}>Application: <code>{stagingCapability.applicationName}</code></p>
                )}
                {stagingCapability.applicationUuid && (
                  <p style={{ margin: 0 }}>UUID: <code>{stagingCapability.applicationUuid}</code></p>
                )}
                {stagingCapability.fqdn && (
                  <p style={{ margin: 0 }}>
                    Domain:{" "}
                    <a href={`https://${stagingCapability.fqdn}`} target="_blank" rel="noopener noreferrer" className="action-link">
                      {stagingCapability.fqdn}
                    </a>
                  </p>
                )}
                {stagingCapability.status && (
                  <p style={{ margin: 0 }}>
                    Status: <span className={`status-chip ${stagingCapability.status}`}>{stagingCapability.status}</span>
                  </p>
                )}
                {stagingCapability.note === "staging_environment_exists_no_application" && (
                  <p className="card-muted" style={{ marginBottom: 0 }}>
                    Staging environment exists but no application is deployed yet. Contact your platform administrator.
                  </p>
                )}
                <p style={{ margin: "0.4rem 0 0", fontSize: "0.75rem", color: "var(--muted)" }}>
                  Checked {formatAgo(stagingCapability.checkedAt)}
                </p>
                <details style={{ marginTop: "0.25rem" }}>
                  <summary style={{ cursor: "pointer", fontSize: "0.8rem", color: "var(--muted)", userSelect: "none" }}>Diagnostic detail</summary>
                  <div style={{ marginTop: "0.4rem", fontSize: "0.8rem", color: "var(--muted)", display: "grid", gap: "0.25rem" }}>
                    {stagingCapability.note ? <p style={{ margin: 0 }}>Note: <code>{stagingCapability.note}</code></p> : null}
                    {appUuid ? <p style={{ margin: 0 }}>App UUID: <code>{appUuid}</code></p> : null}
                  </div>
                </details>
              </div>
            ) : (
              <div>
                <p className="card-muted">
                  {getStagingDetectionMessage(stagingCapability.note)}
                </p>
                <p style={{ margin: "0.4rem 0 0", fontSize: "0.75rem", color: "var(--muted)" }}>
                  Checked {formatAgo(stagingCapability.checkedAt)}
                </p>
                <details style={{ marginTop: "0.25rem" }}>
                  <summary style={{ cursor: "pointer", fontSize: "0.8rem", color: "var(--muted)", userSelect: "none" }}>Diagnostic detail</summary>
                  <div style={{ marginTop: "0.4rem", fontSize: "0.8rem", color: "var(--muted)", display: "grid", gap: "0.25rem" }}>
                    {stagingCapability.note ? <p style={{ margin: 0 }}>Note: <code>{stagingCapability.note}</code></p> : null}
                    {appUuid ? <p style={{ margin: 0 }}>App UUID: <code>{appUuid}</code></p> : null}
                  </div>
                </details>
              </div>
            )}
          </article>

          {/* Dry-Run Sync Plan */}
          {dryRunPlan && (
            <article className="card">
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.75rem" }}>
                <h3 className="card-title" style={{ margin: 0 }}>Sync Plan (Dry Run)</h3>
                <span className="tag">Read-only preview</span>
              </div>
              <p className="card-muted" style={{ marginBottom: "1rem" }}>
                This is a read-only plan of what a production→staging sync would do. No changes have been made.
              </p>

              <div style={{ display: "grid", gap: "0.6rem", fontSize: "0.88rem", marginBottom: "1rem" }}>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <span style={{ fontWeight: 600, minWidth: "140px" }}>Source:</span>
                  <span>{dryRunPlan.source.name} <span className="tag">{dryRunPlan.source.environment}</span></span>
                </div>
                {dryRunPlan.target ? (
                  <>
                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      <span style={{ fontWeight: 600, minWidth: "140px" }}>Target:</span>
                      <span>{dryRunPlan.target.name} <span className="tag">{dryRunPlan.target.environment}</span></span>
                    </div>
                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      <span style={{ fontWeight: 600, minWidth: "140px" }}>Database:</span>
                      <span>{dryRunPlan.databaseBehavior.replace(/-/g, " ")}</span>
                    </div>
                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      <span style={{ fontWeight: 600, minWidth: "140px" }}>Files:</span>
                      <span>{dryRunPlan.filesBehavior.replace(/-/g, " ")}</span>
                    </div>
                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      <span style={{ fontWeight: 600, minWidth: "140px" }}>Domain:</span>
                      <span>{dryRunPlan.domainBehavior.replace(/-/g, " ")}</span>
                    </div>
                  </>
                ) : (
                  <p className="card-muted">Target staging application not available – sync cannot be planned.</p>
                )}
              </div>

              {dryRunPlan.risks.length > 0 && (
                <div style={{ background: "var(--surface-alt)", borderRadius: "8px", padding: "0.75rem", marginBottom: "0.75rem" }}>
                  <p style={{ margin: "0 0 0.5rem", fontWeight: 600, fontSize: "0.88rem" }}>Risks</p>
                  <ul style={{ margin: 0, paddingLeft: "1.2rem", display: "grid", gap: "0.25rem" }}>
                    {dryRunPlan.risks.map((risk, i) => (
                      <li key={i} style={{ fontSize: "0.85rem", color: "var(--muted)" }}>{risk}</li>
                    ))}
                  </ul>
                </div>
              )}

              {dryRunPlan.warnings.length > 0 && (
                <div style={{ background: "var(--surface-alt)", borderRadius: "8px", padding: "0.75rem" }}>
                  <p style={{ margin: "0 0 0.5rem", fontWeight: 600, fontSize: "0.88rem" }}>Warnings</p>
                  <ul style={{ margin: 0, paddingLeft: "1.2rem", display: "grid", gap: "0.25rem" }}>
                    {dryRunPlan.warnings.map((warning, i) => (
                      <li key={i} style={{ fontSize: "0.85rem", color: "var(--muted)" }}>{warning}</li>
                    ))}
                  </ul>
                </div>
              )}

              <p className="card-muted" style={{ marginTop: "0.75rem", marginBottom: 0, fontSize: "0.82rem" }}>
                Sync execution is not available in this interface. Contact your platform administrator to perform a sync via Coolify.
              </p>
            </article>
          )}

          {/* Go Live */}
          <article className="card">
            <h3 className="card-title">Promote to Production</h3>
            <p className="card-muted" style={{ marginBottom: "0.75rem" }}>
              After validating in staging, deploy the current build to production.
            </p>
            <DeployButton
              siteId={siteId}
              deployTargetId={workspace?.deployTargetId}
              environment="production"
              label="Deploy to Production"
              disabled={Boolean(deployLockReason)}
              disabledReason={deployLockReason ?? undefined}
            />
          </article>

          {/* Environment status */}
          <article className="card">
            <h3 className="card-title">Environment Status</h3>
            <div style={{ display: "grid", gap: "0.4rem", marginTop: "0.5rem", fontSize: "0.9rem" }}>
              <p style={{ margin: 0 }}>
                Production: <span className={`status-chip ${workspace?.productionStatus ?? "unknown"}`}>{workspace?.productionStatus ?? "unknown"}</span>
              </p>
              <p style={{ margin: 0 }}>
                Staging: <span className={`status-chip ${workspace?.stagingStatus ?? "unknown"}`}>{workspace?.stagingStatus ?? "unknown"}</span>
              </p>
            </div>
          </article>
        </>
      ) : (
        <article className="card">
          <h3 className="card-title">Staging Not Configured</h3>
          <p className="card-muted" style={{ marginBottom: 0 }}>
            Coolify does not currently report a usable staging environment for this app. Staging sync, promote, and dry-run actions stay hidden until one is detected.
          </p>
        </article>
      )}
    </div>
  );
}
