import { getCoolifyOverview, getCoolifyAppBackupInventory, getCoolifyAppStagingCapability, AppBackupInventory } from "@/lib/coolify";
import { getActivityFeedEmptyMessage } from "@/lib/reason-messages";
import { getBackupReadiness } from "@/lib/deploy-guards";
import { buildBackupReadModelSnapshot } from "@/lib/backup-read-model";
import DeployButton from "@/components/DeployButton";
import { getSiteActivityFeed, getSiteWorkspace } from "@/lib/repositories";
import Link from "next/link";
import { ArrowRightIcon } from "@/components/JongoIcons";
import { auth } from "@/lib/auth.config";
import { notFound } from "next/navigation";
import InfrastructureDiagnostics from "@/components/InfrastructureDiagnostics";
import SiteOverviewCollaboratorsCard from "@/components/SiteOverviewCollaboratorsCard";
import SiteIpAddressCard from "@/components/SiteIpAddressCard";
import SitePrivacyModeControl from "@/components/SitePrivacyModeControl";
import SftpAccessCard from "@/components/SftpAccessCard";
import { buildTemporaryProductionDomain } from "@/lib/temporary-domains";
import { resolveSitePermissionSnapshot } from "@/lib/permissions";

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

type OverviewDomain = {
  label: string;
  value: string;
  detail: string;
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

function summarizeReadiness(checks: ReadinessCheck[]): { state: ReadinessState; detail: string } {
  if (checks.some((check) => check.state === "not_configured")) {
    return { state: "not_configured", detail: "Core platform configuration still needs setup." };
  }
  if (checks.some((check) => check.state === "attention")) {
    return { state: "attention", detail: "A maintenance checkpoint needs follow-up." };
  }
  if (checks.every((check) => check.state === "unknown")) {
    return { state: "unknown", detail: "Maintenance telemetry is unavailable, so readiness cannot be confirmed." };
  }
  if (checks.every((check) => check.state === "ready" || check.state === "unknown")) {
    return { state: "ready", detail: "Core managed checkpoints are in a healthy state." };
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

function buildOverviewDomains(
  workspace: Awaited<ReturnType<typeof getSiteWorkspace>>,
  site?: { deployTargetId: string; name: string; coolifyEnvironmentName?: string | null; coolifyProjectName?: string | null; resourceType?: string; siteType?: string }
): OverviewDomain[] {
  const temporaryDomain = buildTemporaryProductionDomain({
    slug: workspace?.temporaryDomainSlug ?? workspace?.slug ?? workspace?.name,
    suffix: workspace?.temporaryDomainSuffix
  });

  // What Coolify actually serves wins. This row used to show the temporary
  // domain unconditionally — an address built from the slug — so every app that
  // had a real domain pointed at it displayed the wrong one.
  const liveDomain = workspace?.primaryDomain?.trim() || "";
  const primaryDomain = liveDomain || temporaryDomain;

  return [
    {
      label: "Primary domain",
      value: primaryDomain ?? "Not generated yet",
      detail: liveDomain
        ? "The domain configured for this app in its hosting environment."
        : temporaryDomain
          ? "Temporary address — no custom domain is configured yet."
          : "Set a production slug in Settings to generate the site URL."
    },
    {
      label: "Deployment target",
      value: site?.name ?? workspace?.coolifyProjectName ?? "Unassigned",
      detail: site?.coolifyEnvironmentName
        ? `Environment: ${site.coolifyEnvironmentName}`
        : workspace?.coolifyEnvironmentName
          ? `Environment: ${workspace.coolifyEnvironmentName}`
          : site?.deployTargetId ?? workspace?.deployTargetId ?? "No live target linked yet."
    },
    {
      label: "Resource type",
      value: site?.resourceType ?? workspace?.siteType ?? "Unknown",
      detail: workspace?.siteType === "wordpress"
        ? "WordPress sites expose a plugin tab and admin-oriented workflows."
        : "Non-WordPress apps stay on the standard overview workflow."
    }
  ];
}

function resolveHostingIpAddress(): string | null {
  const explicitIp = process.env.HOSTING_SERVER_IP?.trim();
  if (explicitIp) {
    return explicitIp;
  }

  const sshHost = process.env.STAGING_SYNC_SSH_HOST?.trim();
  if (sshHost && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(sshHost)) {
    return sshHost;
  }

  return null;
}

export default async function SiteOverviewPage({ params }: Params) {
  const { siteId } = await params;
  const session = await auth();
  const viewer = {
    userId: session?.user?.id,
    email: session?.user?.email
  };

  const workspace = await getSiteWorkspace(siteId, viewer);
  if (!workspace) {
    notFound();
  }

  const permissions = await resolveSitePermissionSnapshot({ siteId, workspace, viewer });
  const canViewDiagnostics = permissions.canViewDiagnostics;
  const isCollaboratorView = permissions.role === "collaborator";
  const isWordPress = workspace.siteType === "wordpress";

  const overview = await getCoolifyOverview();
  const siteActivity = isCollaboratorView ? [] : await getSiteActivityFeed(siteId, 6, viewer);

  const coolifyId = workspace.coolifyServiceUuid ?? siteId;
  const site = overview.sites.find((item) => item.id === coolifyId || item.deployTargetId === coolifyId);
  const overviewDomains = buildOverviewDomains(workspace, site);

  const backupInventory = workspace.coolifyServiceUuid
    ? await getCoolifyAppBackupInventory(workspace.coolifyServiceUuid)
    : null;

  const restoreVerificationRecord = workspace.coolifyServiceUuid
    ? await (async () => {
        const { getDb } = await import("@/lib/db");
        const prisma = await getDb();

        if (!prisma || !("backupRestoreVerification" in prisma)) {
          return null;
        }

        try {
          return await (prisma as any).backupRestoreVerification.findUnique({
            where: { resourceUuid: workspace.coolifyServiceUuid! }
          });
        } catch {
          return null;
        }
      })()
    : null;

  const stagingCapability = workspace.coolifyServiceUuid
    ? await getCoolifyAppStagingCapability(workspace.coolifyServiceUuid, workspace.coolifyProjectId ?? undefined, /* Relaxed: must match the API route, or the UI hides staging the platform did provision. */ { relaxedTargetMatch: true })
    : null;

  const backupReadiness = getBackupReadiness(backupInventory, workspace.coolifyServiceUuid);
  // Live-derived, so an app added later is judged correctly with no setup.
  const backupNotApplicable = backupReadiness.code === "backups_not_applicable";
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
    schedules: backupInventory?.schedules.filter((schedule) => schedule.enabled),
    restoreVerification: restoreVerificationRecord
      ? {
          lastVerifiedAt: restoreVerificationRecord.lastVerifiedAt.toISOString(),
          lastResult: restoreVerificationRecord.lastResult === "pass" ? "pass" : "fail",
          rpoHours: restoreVerificationRecord.rpoHours
        }
      : undefined
  });

  // Databases nested under this app by the reconciler. Coolify registers a
  // standalone database as its own resource, so without this it appeared as a
  // separate app beside the one whose data it holds.
  const nestedDatabases = await (async () => {
    try {
      const { getDb } = await import("@/lib/db");
      const prisma = await getDb();
      if (!prisma) return [];
      return await (prisma as any).site.findMany({
        where: { parentSiteId: workspace.id, deletedAt: null },
        // No `status` here: Site has no such column — health is derived from
        // Coolify, not stored. Selecting it made Prisma reject the query, and
        // the catch below swallowed it, so nested databases silently never
        // appeared while the error filled the logs.
        select: { id: true, slug: true, name: true, coolifyServiceUuid: true },
        orderBy: { name: "asc" }
      });
    } catch {
      return [];
    }
  })();

  const stagingEnvironmentReady = Boolean(stagingCapability?.detected);
  const stagingTargetAttached = Boolean(stagingCapability?.applicationUuid);
  const stagingConfigured = Boolean(workspace.stagingEnabled && stagingEnvironmentReady && stagingTargetAttached);
  const workflowModel = getResourceWorkflowModel(workspace.siteType);
  const hostingServerIp = resolveHostingIpAddress();
  const hostingServerCountryName = process.env.HOSTING_SERVER_COUNTRY?.trim() || "United States";

  let readinessChecks: ReadinessCheck[] = [];
  let readinessSummary = { state: "unknown" as ReadinessState, detail: "" };

  if (canViewDiagnostics) {
    readinessChecks = [
      {
        key: "backup-configured",
        label: "Backups configured",
        // An app with no databases has no schedule to configure, so flagging it
        // "not configured" and telling the owner to go add one sends them after
        // a fault that does not exist. Same verdict the Backups tab uses.
        state: !workspace.coolifyServiceUuid
          ? "not_configured"
          : backupInventory?.source !== "live"
            ? "unknown"
            : backupNotApplicable
              ? "unknown"
              : backupInventory?.configured
                ? "ready"
                : "not_configured",
        detail: !workspace.coolifyServiceUuid
          ? "No infrastructure app UUID is linked to this app."
          : backupInventory?.source !== "live"
            ? "Could not reach live backup inventory from platform."
            : backupNotApplicable
              ? "This app has no database, so there is no backup schedule to configure."
              : backupInventory?.configured
                ? "At least one active database backup schedule is present."
                : "No active backup schedules were found.",
        nextStep: backupNotApplicable
          ? ""
          : "Open Backups and configure recurring schedules in the platform."
      },
      {
        key: "recent-backup",
        label: "Recent backup",
        state: backupInventory?.source !== "live"
          ? "unknown"
          : backupNotApplicable
            ? "unknown"
            : !lastSuccessfulBackup
              ? "attention"
              : recentBackupHealthy
                ? "ready"
                : "attention",
        detail: backupInventory?.source !== "live"
          ? "Recent execution history is unavailable."
          : backupNotApplicable
            ? "There is no data to back up for this app, so no backup is expected."
            : !lastSuccessfulBackup
              ? "No successful backup was found in recent execution history."
              : recentBackupHealthy
                ? `Last successful backup was ${formatAgo(lastSuccessfulBackup)}.`
                : `Last successful backup was ${formatAgo(lastSuccessfulBackup)}, which exceeds 7 days.`,
        nextStep: backupNotApplicable
          ? ""
          : "Investigate backup failures and run a fresh successful backup."
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
        state: stagingConfigured ? "ready" : workspace.stagingEnabled ? "attention" : "not_configured",
        detail: stagingConfigured
          ? "Staging environment and target are both attached."
          : workspace.stagingEnabled && stagingEnvironmentReady
            ? "Staging environment exists but no staging target is attached yet."
            : workspace.stagingEnabled
              ? "Staging is enabled but no staging environment is detected in the platform."
              : "Staging is not configured for this app.",
        nextStep: "Configure staging environment mapping in app settings."
      },
      {
        key: "platform-api",
        label: "Platform API reachable",
        state: overview.mode === "live" ? (overview.fetchError ? "attention" : "ready") : "unknown",
        detail:
          overview.mode === "live"
            ? overview.fetchError
              ? "Platform API is configured but recent fetch returned errors."
              : "Platform API is configured and telemetry is updating."
            : "Platform API is not configured (mock mode).",
        nextStep: "Verify platform API tokens and base URL runtime env values."
      }
    ];

    // An app with no data to back up should not be asked backup questions at
    // all. Leaving the rows in as "unknown" still reads as an unfinished setup
    // step, which is the thing being fixed.
    if (backupNotApplicable) {
      readinessChecks = readinessChecks.filter(
        (check) => check.key !== "backup-configured" && check.key !== "recent-backup"
      );
    }

    readinessSummary = summarizeReadiness(readinessChecks);
  }

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <section style={{ display: "flex", flexWrap: "wrap", gap: "1rem", alignItems: "flex-start" }}>
        <div style={{ flex: "3 1 680px", minWidth: "320px" }}>
          {nestedDatabases.length > 0 ? (
            <article className="card" style={{ marginBottom: "1rem" }}>
              <h3 className="card-title">
                {nestedDatabases.length === 1 ? "Database" : "Databases"}
              </h3>
              <p className="card-muted" style={{ marginTop: "0.25rem" }}>
                {nestedDatabases.length === 1
                  ? "This app stores its data here. It is backed up as part of this app."
                  : "This app stores its data here. They are backed up as part of this app."}
              </p>
              <div style={{ display: "grid", gap: "0.5rem", marginTop: "0.75rem" }}>
                {nestedDatabases.map((entry: { id: string; slug: string | null; name: string; status?: string | null }) => (
                  <div
                    key={entry.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "0.75rem",
                      border: "1px solid var(--border)",
                      borderRadius: "10px",
                      padding: "0.6rem 0.8rem"
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{entry.name}</span>
                    <span className={`status-chip ${entry.status === "healthy" ? "healthy" : "unknown"}`}>
                      {entry.status === "healthy" ? "Healthy" : "Database"}
                    </span>
                  </div>
                ))}
              </div>
            </article>
          ) : null}

          <article className="card">
            <h3 className="card-title">Domains</h3>
            <div style={{ display: "grid", gap: "0.8rem", marginTop: "0.8rem" }}>
              {overviewDomains.map((domain) => (
                <div key={domain.label} style={{ paddingBottom: "0.65rem", borderBottom: "1px solid var(--border)" }}>
                  <p style={{ margin: 0, fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--muted)" }}>{domain.label}</p>
                  <p style={{ margin: "0.2rem 0 0", fontWeight: 600 }}>{domain.value}</p>
                  <p style={{ margin: "0.25rem 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>{domain.detail}</p>
                </div>
              ))}
            </div>
            <p style={{ margin: "0.8rem 0 0" }}>
              <Link href={`/apps/${siteId}/settings`} className="action-link">
                Update domains <ArrowRightIcon className="btn-icon" />
              </Link>
            </p>
          </article>
        </div>

        <div style={{ flex: "1 1 280px", minWidth: "260px", display: "grid", gap: "1rem" }}>
          <SiteOverviewCollaboratorsCard siteId={siteId} currentUserId={session?.user?.id ?? ""} clientId={workspace.clientId} />

          <SiteIpAddressCard ipAddress={hostingServerIp} countryName={hostingServerCountryName} />

          <article className="card">
            <SftpAccessCard siteId={siteId} canManage={permissions.canManageSftp} />
          </article>

          <article className="card">
            <SitePrivacyModeControl
              siteId={siteId}
              isWordPress={isWordPress}
              canEnable={permissions.canEnablePrivacyMode}
              canDisable={permissions.canDisablePrivacyMode}
              canManageCredentials={permissions.canManagePrivacyCredentials}
              isCollaboratorView={isCollaboratorView}
            />
          </article>
        </div>
      </section>

      {canViewDiagnostics ? (
        <InfrastructureDiagnostics
          readinessChecks={readinessChecks}
          readinessSummary={readinessSummary}
          siteId={siteId}
        />
      ) : null}

      {!isCollaboratorView ? (
        <>
          <div className="grid">
            <article className="card">
              <h3 className="card-title">Activity feed</h3>
              {siteActivity.length === 0 ? (
                <p className="card-muted" style={{ marginBottom: 0 }}>
                  {getActivityFeedEmptyMessage(!site, Boolean(overview.fetchError))}
                </p>
              ) : (
                <div style={{ marginTop: "0.75rem", display: "grid", gap: "0.55rem" }}>
                  {siteActivity.map((item) => (
                    <div
                      key={item.id}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "flex-start",
                        gap: "0.75rem",
                        paddingBottom: "0.55rem",
                        borderBottom: "1px solid var(--border)"
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ margin: 0, fontSize: "0.9rem", fontWeight: 500 }}>{item.title}</p>
                        <p style={{ margin: "0.2rem 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>
                          {item.detail}
                          {item.durationSeconds !== undefined ? ` - ${formatDuration(item.durationSeconds)}` : ""}
                          {item.timestamp ? ` - ${new Date(item.timestamp).toLocaleString()}` : ""}
                        </p>
                      </div>
                      <div style={{ display: "flex", gap: "0.35rem", flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" }}>
                        {item.environment && item.environment !== "unknown" ? (
                          <span className="status-chip unknown" style={{ fontSize: "0.72rem" }}>{item.environment}</span>
                        ) : null}
                        <span className={`status-chip ${item.status}`}>{item.status}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </article>

            <article className="card">
              <h3 className="card-title">Backups</h3>
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
                {canViewDiagnostics ? (
                  <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--muted)" }}>{backupReadModel.offsite.detail}</p>
                ) : null}
                <div style={{ display: "flex", alignItems: "center", gap: "0.45rem", flexWrap: "wrap" }}>
                  <p style={{ margin: 0, fontSize: "0.86rem" }}>Restore verified:</p>
                  <span className={`status-chip ${backupReadModel.restoreVerification.tone}`}>
                    {backupReadModel.restoreVerification.label}
                  </span>
                </div>
                {canViewDiagnostics ? (
                  <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--muted)" }}>
                    {backupReadModel.restoreVerification.detail}
                  </p>
                ) : null}
                <p style={{ margin: 0, fontSize: "0.86rem" }}>
                  Restore scope: <strong>{backupReadModel.restoreScope}</strong>
                </p>
                {canViewDiagnostics ? (
                  <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--muted)" }}>
                    Staging safety: {backupReadModel.stagingSafety}. {backupReadModel.stagingSafetyDetail}
                  </p>
                ) : null}
              </div>
              <p style={{ margin: "0.7rem 0 0", fontSize: "0.9rem" }}>
                <Link href={`/apps/${siteId}/backups`} className="action-link">
                  Open backup details <ArrowRightIcon className="btn-icon" />
                </Link>
              </p>
            </article>

            <article className="card">
              <h3 className="card-title">Publishing and workflow</h3>
              <p className="card-muted" style={{ marginBottom: "0.5rem" }}>{workflowModel.body}</p>
              <span className="tag" style={{ marginBottom: "0.5rem", display: "inline-flex" }}>{workflowModel.title}</span>
              <ul style={{ margin: 0, paddingLeft: "1.15rem", display: "grid", gap: "0.25rem" }}>
                {workflowModel.bullets.map((item) => (
                  <li key={item} style={{ fontSize: "0.85rem", color: "var(--muted)" }}>{item}</li>
                ))}
              </ul>
              {stagingConfigured ? (
                <>
                  <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.85rem" }}>
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
                  <p style={{ margin: "0.7rem 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>{backupLockReason}</p>
                  <p style={{ margin: "0.75rem 0 0" }}>
                    <Link href={`/apps/${siteId}/staging`} className="action-link">
                      Open publishing workflow <ArrowRightIcon className="btn-icon" />
                    </Link>
                  </p>
                </>
              ) : (
                <p className="card-muted" style={{ margin: "0.8rem 0 0" }}>
                  Staging is not configured yet, so publishing controls stay hidden here.
                </p>
              )}
            </article>
          </div>

          <div className="grid">
            <article className="card">
              <h3 className="card-title">What to do next</h3>
              <p style={{ margin: "0.35rem 0", fontSize: "0.9rem" }}>
                <Link href={`/apps/${siteId}/analytics`} className="action-link">
                  Review deployment analytics <ArrowRightIcon className="btn-icon" />
                </Link>
              </p>
              <p style={{ margin: "0.35rem 0", fontSize: "0.9rem" }}>
                <Link href={`/apps/${siteId}/settings`} className="action-link">
                  Update site settings <ArrowRightIcon className="btn-icon" />
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
            </article>
          </div>
        </>
      ) : null}
    </div>
  );
}
