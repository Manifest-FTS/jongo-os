import { getCoolifyAppStagingCapability, buildStagingSyncDryRunPlan } from "@/lib/coolify";
import { getCoolifyAppBackupInventory } from "@/lib/coolify";
import { getStagingDetectionMessage } from "@/lib/reason-messages";
import { getBackupReadiness, getPathPreflight } from "@/lib/deploy-guards";
import PromoteToProductionCard from "@/components/PromoteToProductionCard";
import StagingDomainForm from "@/components/StagingDomainForm";
import StagingAuditHistory from "@/components/StagingAuditHistory";
import CopyTextButton from "@/components/CopyTextButton";
import Link from "next/link";
import { getSiteWorkspace, isClientAdmin } from "@/lib/repositories";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth.config";
import { notFound } from "next/navigation";

type Params = { params: Promise<{ siteId: string }> };

type StagingAuditEntry = {
  id: string;
  createdAt: Date;
  details: unknown;
};

type StagingPromoteOutcome = {
  actionType: "staging_promote_blocked" | "staging_promote_triggered" | "staging_promote_in_progress" | "staging_promote_succeeded" | "staging_promote_failed";
  promoteAttemptId?: string;
  deploymentId?: string;
  deploymentStatus?: string;
  triggeredAt?: string;
  finishedAt?: string;
  message: string;
  createdAt: string;
};

type StagingAuditHistoryItem = {
  id: string;
  createdAt: string;
  actionType?: string;
  message: string;
  domains: string[];
  preferredStagingDomain?: string;
};

function formatAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function getStagingModelCopy(siteType?: string): { title: string; body: string; bullets: string[] } {
  if (siteType === "wordpress") {
    return {
      title: "WordPress staging model (future)",
      body: "WordPress staging will follow a clone-style workflow similar to Flywheel, focused on safe content and update testing.",
      bullets: [
        "Create Staging from Production",
        "Sync Production to Staging",
        "Push Staging to Production",
        "Selective DB/media pull (later)",
        "Execution gated by backup readiness and admin/operator controls"
      ]
    };
  }

  if (siteType === "database") {
    return {
      title: "Database resource model",
      body: "Database resources do not use website-style staging workflows.",
      bullets: [
        "Focus on backup readiness",
        "Restore validation and recovery runbooks",
        "Operational safety checks before destructive actions"
      ]
    };
  }

  if (siteType === "service") {
    return {
      title: "Service resource model",
      body: "Service resources prioritize runtime health and recoverability over clone-style staging.",
      bullets: [
        "Service health and restart readiness",
        "Log and runtime diagnostics",
        "Backup/readiness signals for stateful services"
      ]
    };
  }

  return {
    title: "Web app staging model (future)",
    body: "Web app staging should behave like preview deployments rather than clone-style site staging.",
    bullets: [
      "Branch/PR preview environments",
      "Temporary preview URLs",
      "Pre-merge validation before main deployment",
      "Prefer Coolify preview/staging by git branch when supported",
      "Execution gated by backup readiness and admin/operator controls"
    ]
  };
}

function parseDomainValues(raw?: string): string[] {
  if (!raw) {
    return [];
  }

  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.replace(/^https?:\/\//i, ""));

  return [...new Set(values)];
}

function formatAuditAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function getAuditActionType(entry: StagingAuditEntry): string | undefined {
  const details = entry.details as Record<string, unknown> | null | undefined;
  return typeof details?.actionType === "string" ? details.actionType : undefined;
}

function getLatestDomainSyncEntry(entries: StagingAuditEntry[]): StagingAuditEntry | null {
  const match = entries.find((entry) => {
    const actionType = getAuditActionType(entry);
    return actionType === "staging_domains_updated" || actionType === "staging_domains_update_failed";
  });

  return match ?? null;
}

function getPromoteActionType(entry: StagingAuditEntry): StagingPromoteOutcome["actionType"] | undefined {
  const details = entry.details as Record<string, unknown> | null | undefined;
  const actionType = typeof details?.actionType === "string" ? details.actionType : undefined;

  if (
    actionType === "staging_promote_blocked" ||
    actionType === "staging_promote_triggered" ||
    actionType === "staging_promote_in_progress" ||
    actionType === "staging_promote_succeeded" ||
    actionType === "staging_promote_failed"
  ) {
    return actionType;
  }

  return undefined;
}

function getLatestPromoteOutcome(entries: StagingAuditEntry[]): StagingPromoteOutcome | null {
  const promoteEntry = entries.find((entry) => Boolean(getPromoteActionType(entry)));
  if (!promoteEntry) {
    return null;
  }

  const details = promoteEntry.details as Record<string, unknown> | null | undefined;
  const actionType = getPromoteActionType(promoteEntry);
  if (!actionType) {
    return null;
  }

  return {
    actionType,
    promoteAttemptId: typeof details?.promoteAttemptId === "string" ? details.promoteAttemptId : undefined,
    deploymentId: typeof details?.deploymentId === "string" ? details.deploymentId : undefined,
    deploymentStatus: typeof details?.deploymentStatus === "string" ? details.deploymentStatus : undefined,
    triggeredAt: typeof details?.triggeredAt === "string" ? details.triggeredAt : undefined,
    finishedAt: typeof details?.finishedAt === "string" ? details.finishedAt : undefined,
    message: typeof details?.message === "string" ? details.message : "Production promotion recorded.",
    createdAt: promoteEntry.createdAt.toISOString()
  };
}

function promoteOutcomeTone(actionType: StagingPromoteOutcome["actionType"]): "healthy" | "degraded" | "error" | "unknown" {
  if (actionType === "staging_promote_succeeded") {
    return "healthy";
  }

  if (actionType === "staging_promote_failed" || actionType === "staging_promote_blocked") {
    return "error";
  }

  if (actionType === "staging_promote_in_progress" || actionType === "staging_promote_triggered") {
    return "degraded";
  }

  return "unknown";
}

function promoteOutcomeLabel(actionType: StagingPromoteOutcome["actionType"]): string {
  if (actionType === "staging_promote_succeeded") {
    return "Promotion succeeded";
  }

  if (actionType === "staging_promote_failed") {
    return "Promotion failed";
  }

  if (actionType === "staging_promote_blocked") {
    return "Promotion blocked";
  }

  if (actionType === "staging_promote_in_progress") {
    return "Promotion in progress";
  }

  return "Promotion triggered";
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

  const canManageDomains = Boolean(
    session?.user?.id &&
    workspace.organizationId &&
    await isClientAdmin(workspace.organizationId, session.user.id)
  );

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
  const backupReadiness = getBackupReadiness(backupInventory, appUuid);
  const prodToStagingPreflight = getPathPreflight("production-to-staging", backupReadiness, stagingConfigured);
  const stagingToProdPreflight = getPathPreflight("staging-to-production", backupReadiness, stagingConfigured);
  const promoteLockedReason = !canManageDomains
    ? "Only admins can promote staging to production."
    : stagingToProdPreflight.tone === "error"
      ? stagingToProdPreflight.detail
      : undefined;
  const stagingModelCopy = getStagingModelCopy(workspace?.siteType);
  const stagingDomains = parseDomainValues(stagingCapability?.fqdn);
  const stagingDomainsInput = stagingDomains.join(", ");
  const stagingAuditLogs: StagingAuditEntry[] = workspace.organizationId
    ? await db.auditLog.findMany({
        where: {
          organizationId: workspace.organizationId,
          resourceType: "site_staging",
          resourceId: workspace.id,
          action: "site_updated"
        },
        orderBy: { createdAt: "desc" },
        take: 25
      })
    : [];
  const stagingAuditItems: StagingAuditHistoryItem[] = stagingAuditLogs.map((entry) => {
    const details = entry.details as Record<string, unknown> | null | undefined;
    const actionType = typeof details?.actionType === "string" ? details.actionType : undefined;
    const message = typeof details?.message === "string"
      ? details.message
      : typeof details?.provisioningMessage === "string"
        ? details.provisioningMessage
        : "Staging action recorded.";
    const domains = Array.isArray(details?.domains)
      ? details.domains.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    const preferredStagingDomain = typeof details?.preferredStagingDomain === "string" && details.preferredStagingDomain
      ? details.preferredStagingDomain
      : undefined;

    return {
      id: entry.id,
      createdAt: entry.createdAt.toISOString(),
      actionType,
      message,
      domains,
      preferredStagingDomain
    };
  });
  const latestDomainSyncEntry = getLatestDomainSyncEntry(stagingAuditLogs);
  const latestPromoteOutcome = getLatestPromoteOutcome(stagingAuditLogs);

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
            Enable staging in <Link href={`/apps/${siteId}/settings`} className="action-link">Settings</Link> to trigger Jongo&apos;s auto-provision attempt in Coolify. If unsupported, provision staging manually in Coolify and return here.
          </p>
        )}
      </article>

      {latestPromoteOutcome && latestPromoteOutcome.actionType !== "staging_promote_triggered" && latestPromoteOutcome.actionType !== "staging_promote_in_progress" ? (
        <article className="card">
          <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "flex-start", flexWrap: "wrap" }}>
            <div>
              <h3 className="card-title" style={{ marginBottom: "0.25rem" }}>Latest production promotion</h3>
              <p className="card-muted" style={{ margin: 0 }}>
                {latestPromoteOutcome.message}
              </p>
            </div>
            <span className={`status-chip ${promoteOutcomeTone(latestPromoteOutcome.actionType)}`}>
              {promoteOutcomeLabel(latestPromoteOutcome.actionType)}
            </span>
          </div>
          <div style={{ display: "grid", gap: "0.35rem", marginTop: "0.75rem", fontSize: "0.85rem" }}>
            {latestPromoteOutcome.promoteAttemptId ? (
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                <p style={{ margin: 0, color: "var(--muted)" }}>
                  Attempt id: <code>{latestPromoteOutcome.promoteAttemptId}</code>
                </p>
                <CopyTextButton value={latestPromoteOutcome.promoteAttemptId} label="Copy attempt id" />
              </div>
            ) : null}
            {latestPromoteOutcome.deploymentId ? (
              <p style={{ margin: 0, color: "var(--muted)" }}>
                Deployment id: <code>{latestPromoteOutcome.deploymentId}</code>
              </p>
            ) : null}
            {latestPromoteOutcome.deploymentStatus ? (
              <p style={{ margin: 0, color: "var(--muted)" }}>
                Deployment status: <span className={`status-chip ${promoteOutcomeTone(latestPromoteOutcome.actionType)}`}>{latestPromoteOutcome.deploymentStatus.replace("_", " ")}</span>
              </p>
            ) : null}
            {latestPromoteOutcome.finishedAt ? (
              <p style={{ margin: 0, color: "var(--muted)" }}>
                Completed {formatAgo(latestPromoteOutcome.finishedAt)}
              </p>
            ) : latestPromoteOutcome.triggeredAt ? (
              <p style={{ margin: 0, color: "var(--muted)" }}>
                Started {formatAgo(latestPromoteOutcome.triggeredAt)}
              </p>
            ) : null}
            <p style={{ margin: 0, color: "var(--muted)" }}>
              Updated {formatAgo(latestPromoteOutcome.createdAt)}
            </p>
          </div>
        </article>
      ) : null}

      <>
          <article className="card">
            <h3 className="card-title">{stagingModelCopy.title}</h3>
            <p className="card-muted" style={{ marginBottom: "0.65rem" }}>{stagingModelCopy.body}</p>
            <ul style={{ margin: 0, paddingLeft: "1.2rem", display: "grid", gap: "0.25rem" }}>
              {stagingModelCopy.bullets.map((item) => (
                <li key={item} style={{ fontSize: "0.85rem", color: "var(--muted)" }}>{item}</li>
              ))}
            </ul>
          </article>

          <article className="card">
            <h3 className="card-title">Pre-flight Status</h3>
            <p className="card-muted" style={{ marginBottom: "0.75rem" }}>
              Use these checks to confirm readiness. Production promotion is enabled only when staging-to-production preflight is ready.
            </p>
            <p style={{ margin: "0 0 0.75rem", fontSize: "0.88rem" }}>
              Programmatic testing: <code>GET /api/sites/{siteId}/staging</code> returns sync-readiness and dry-run plan details.
            </p>
            <div style={{ display: "grid", gap: "0.65rem" }}>
              <div style={{ border: "1px solid var(--border)", borderRadius: "8px", padding: "0.65rem 0.75rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" }}>
                  <strong style={{ fontSize: "0.9rem" }}>Production to Staging</strong>
                  <span className={`status-chip ${prodToStagingPreflight.tone}`}>{prodToStagingPreflight.label}</span>
                </div>
                <p style={{ margin: "0.35rem 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>{prodToStagingPreflight.detail}</p>
              </div>
              <div style={{ border: "1px solid var(--border)", borderRadius: "8px", padding: "0.65rem 0.75rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" }}>
                  <strong style={{ fontSize: "0.9rem" }}>Staging to Production</strong>
                  <span className={`status-chip ${stagingToProdPreflight.tone}`}>{stagingToProdPreflight.label}</span>
                </div>
                <p style={{ margin: "0.35rem 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>{stagingToProdPreflight.detail}</p>
              </div>
            </div>
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
                {stagingDomains.length > 0 && (
                  <div style={{ margin: 0 }}>
                    <p style={{ margin: 0 }}>Domains:</p>
                    <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1rem", display: "grid", gap: "0.15rem" }}>
                      {stagingDomains.map((domain) => (
                        <li key={domain} style={{ fontSize: "0.86rem" }}>
                          <a href={`https://${domain}`} target="_blank" rel="noopener noreferrer" className="action-link">
                            {domain}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
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
                {canManageDomains ? (
                  <>
                    <StagingDomainForm
                      siteId={siteId}
                      initialDomains={stagingDomainsInput}
                    />
                    {latestDomainSyncEntry ? (
                      <p style={{ margin: "0.25rem 0 0", fontSize: "0.8rem", color: "var(--muted)" }}>
                        <span className={`status-chip ${getAuditActionType(latestDomainSyncEntry) === "staging_domains_updated" ? "healthy" : "error"}`}>
                          {getAuditActionType(latestDomainSyncEntry) === "staging_domains_updated" ? "Last domain sync: success" : "Last domain sync: failed"}
                        </span>{" "}
                        {formatAuditAgo(latestDomainSyncEntry.createdAt.toISOString())}
                      </p>
                    ) : (
                      <p style={{ margin: "0.25rem 0 0", fontSize: "0.8rem", color: "var(--muted)" }}>
                        Last domain sync: no attempts recorded yet.
                      </p>
                    )}
                  </>
                ) : null}
                <p style={{ margin: "0.4rem 0 0", fontSize: "0.75rem", color: "var(--muted)" }}>
                  Checked {formatAgo(stagingCapability.checkedAt)}
                </p>
              </div>
            ) : (
              <div>
                <p className="card-muted">
                  {getStagingDetectionMessage(stagingCapability.note)}
                </p>
                <p style={{ margin: "0.4rem 0 0", fontSize: "0.75rem", color: "var(--muted)" }}>
                  Checked {formatAgo(stagingCapability.checkedAt)}
                </p>
                <p style={{ margin: "0.65rem 0 0", fontSize: "0.88rem" }}>
                  <Link href={`/apps/${siteId}/settings`} className="action-link">Open app settings to verify staging/resource mapping</Link>
                </p>
              </div>
            )}
          </article>

          {/* Dry-Run Sync Plan */}
          {dryRunPlan && (
            <>
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

              <StagingAuditHistory items={stagingAuditItems} />
            </>
          )}

          {/* Go Live */}
          <article className="card">
            <h3 className="card-title">Promote to Production</h3>
            <p className="card-muted" style={{ marginBottom: "0.75rem" }}>
              After validating in staging, promote to production once backup readiness is healthy.
            </p>
            <PromoteToProductionCard
              siteId={siteId}
              disabled={Boolean(promoteLockedReason)}
              disabledReason={promoteLockedReason}
              preflightLabel={stagingToProdPreflight.label}
              preflightTone={stagingToProdPreflight.tone}
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
                Coolify does not currently report a usable staging environment for this app. Sync and promote controls stay hidden until staging is detected.
          </p>
              <p style={{ margin: "0.75rem 0 0", fontSize: "0.9rem" }}>
                Next step: configure staging in <Link href={`/apps/${siteId}/settings`} className="action-link">Settings</Link>, then return here for dry-run preflight and workflow previews.
              </p>
        </article>
      )}
      </>
    </div>
  );
}
