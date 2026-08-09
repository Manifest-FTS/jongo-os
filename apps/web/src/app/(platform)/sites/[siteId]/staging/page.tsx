import {
  getCoolifyAppStagingCapability,
  buildStagingSyncDryRunPlan,
  deriveCoolifyStagingDomainFromProduction
} from "@/lib/coolify";
import { getCoolifyAppBackupInventory } from "@/lib/coolify";
import { getStagingDetectionMessage } from "@/lib/reason-messages";
import { getBackupReadiness, getPathPreflight } from "@/lib/deploy-guards";
import PromoteToProductionCard from "@/components/PromoteToProductionCard";
import StagingActionsPanel from "@/components/StagingActionsPanel";
import PageAutoRefresh from "@/components/PageAutoRefresh";
import StagingDomainForm from "@/components/StagingDomainForm";
import StagingAuditHistory from "@/components/StagingAuditHistory";
import CopyTextButton from "@/components/CopyTextButton";
import Link from "next/link";
import { getSiteWorkspace } from "@/lib/repositories";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth.config";
import { notFound } from "next/navigation";
import { resolveSitePermissionSnapshot } from "@/lib/permissions";

type Params = {
  params: Promise<{ siteId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

type StagingAuditEntry = {
  id: string;
  createdAt: Date;
  details: unknown;
};

type StagingAuditActor = {
  id: string;
  fullName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
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
  promoteAttemptId?: string;
  message: string;
  domains: string[];
  preferredStagingDomain?: string;
  actor?: StagingAuditActor;
};

type ActualSyncTestReadiness = {
  ready: boolean;
  tone: "healthy" | "degraded" | "error" | "unknown";
  label: string;
  summary: string;
  blockers: string[];
  checks: string[];
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

function getActualSyncTestReadiness(params: {
  stagingConfigured: boolean;
  preflightTone: "healthy" | "degraded" | "error" | "unknown";
  preflightDetail: string;
  hasDryRunTarget: boolean;
  databaseBehavior?: string;
  filesBehavior?: string;
}): ActualSyncTestReadiness {
  const checks = [
    "Staging environment is configured and target is attached.",
    "Production-to-staging preflight is healthy.",
    "Dry-run plan reports target, database, and files behaviors.",
    "Operational pass scope allows real production file+DB sync testing."
  ];

  const blockers: string[] = [];

  if (!params.stagingConfigured) {
    blockers.push("Staging is not fully configured.");
  }

  if (params.preflightTone !== "healthy") {
    blockers.push(`Preflight is not healthy: ${params.preflightDetail}`);
  }

  if (!params.hasDryRunTarget) {
    blockers.push("Dry-run plan has no staging target.");
  }

  if (params.databaseBehavior && params.databaseBehavior !== "snapshot-then-overwrite") {
    blockers.push(`Unexpected database behavior: ${params.databaseBehavior}.`);
  }

  if (params.filesBehavior && params.filesBehavior !== "rsync-overwrite") {
    blockers.push(`Unexpected files behavior: ${params.filesBehavior}.`);
  }

  if (blockers.length > 0) {
    return {
      ready: false,
      tone: "error",
      label: "Not ready",
      summary: "Do not run live production file+DB sync testing yet.",
      blockers,
      checks
    };
  }

  return {
    ready: true,
    tone: "healthy",
    label: "Ready",
    summary: "Prerequisites are satisfied for a controlled production file+DB sync test.",
    blockers: [],
    checks
  };
}

export default async function StagingPage({ params, searchParams }: Params) {
  const { siteId } = await params;
  const resolvedSearchParams = (await searchParams) ?? {};
  const searchAttemptIdRaw = resolvedSearchParams.attemptId;
  const searchDebugRaw = resolvedSearchParams.debug;
  const initialAttemptId = Array.isArray(searchAttemptIdRaw)
    ? searchAttemptIdRaw[0]?.trim() ?? ""
    : searchAttemptIdRaw?.trim() ?? "";
  const debugRequested = (Array.isArray(searchDebugRaw) ? searchDebugRaw[0] : searchDebugRaw) === "1";
  const session = await auth();
  const workspace = await getSiteWorkspace(siteId, {
    userId: session?.user?.id,
    email: session?.user?.email
  });

  if (!workspace) {
    notFound();
  }

  const permissionSnapshot = await resolveSitePermissionSnapshot({
    siteId,
    workspace,
    viewer: {
      userId: session?.user?.id,
      email: session?.user?.email
    }
  });

  const canManageDomains = Boolean(session?.user?.id && permissionSnapshot.canManageStaging);

  const stagingEnabled = Boolean(workspace?.stagingEnabled);
  const appUuid = workspace?.coolifyServiceUuid;
  const projectId = workspace?.coolifyProjectId;

  const [stagingCapability, backupInventory] = appUuid
    ? await Promise.all([
      getCoolifyAppStagingCapability(appUuid, projectId ?? undefined, /* Relaxed: must match the API route, or the UI hides staging the platform did provision. */ { relaxedTargetMatch: true }),
      getCoolifyAppBackupInventory(appUuid)
    ])
    : [null, null];
  const preferredStagingUrl = appUuid
    ? await deriveCoolifyStagingDomainFromProduction(appUuid, {
      siteSlug: workspace.temporaryDomainSlug ?? workspace.slug ?? workspace.id,
      siteName: workspace.name
    })
    : undefined;
  const stagingEnvironmentReady = Boolean(stagingCapability?.detected);
  const stagingTargetAttached = Boolean(stagingCapability?.applicationUuid);
  const stagingTargetRunning = stagingCapability?.status === "healthy";
  const stagingConfigured = Boolean(stagingEnabled && stagingEnvironmentReady && stagingTargetAttached);
  // Jongo's own backup history: the restic snapshots that are the actual
  // protection for a WordPress stack, which Coolify's telemetry cannot see.
  const jongoBackupState = await (async () => {
    try {
      const { getDb } = await import("@/lib/db");
      const prisma = await getDb();
      if (!prisma || !("siteBackup" in prisma)) return null;
      const last = await (prisma as any).siteBackup.findFirst({
        where: { siteId: workspace.id, status: "success" },
        orderBy: { completedAt: "desc" },
        select: { completedAt: true }
      });
      return { lastSuccessAt: last?.completedAt ?? null };
    } catch {
      // Unknown is not "never": fall back to the Coolify rule rather than
      // locking on a database hiccup.
      return null;
    }
  })();

  const backupReadiness = getBackupReadiness(backupInventory, appUuid, jongoBackupState);
  const prodToStagingPreflight = getPathPreflight("production-to-staging", backupReadiness, stagingConfigured);
  const stagingToProdPreflight = getPathPreflight("staging-to-production", backupReadiness, stagingConfigured);
  const promoteLockedReason = !canManageDomains
    ? "You do not have permission to promote staging to production."
    : stagingToProdPreflight.tone === "error"
      ? stagingToProdPreflight.detail
      : undefined;
  const debugDefaultEnabled = (process.env.STAGING_UI_DEBUG_DEFAULT || "false").toLowerCase() === "true";
  const debugViewEnabled = canManageDomains && (debugRequested || debugDefaultEnabled);
  const enableDebugHref = `/sites/${siteId}/staging?debug=1${initialAttemptId ? `&attemptId=${encodeURIComponent(initialAttemptId)}` : ""}`;
  const disableDebugHref = `/sites/${siteId}/staging${initialAttemptId ? `?attemptId=${encodeURIComponent(initialAttemptId)}` : ""}`;
  const reportedStagingDomains = parseDomainValues(stagingCapability?.fqdn ?? stagingCapability?.stagingUrl);
  const preferredDomainValue = preferredStagingUrl ? parseDomainValues(preferredStagingUrl)[0] : undefined;
  const preferredDomainConverged = preferredDomainValue
    ? reportedStagingDomains.some((domain) => domain.toLowerCase() === preferredDomainValue.toLowerCase())
    : true;
  const stagingDomainsInput = (reportedStagingDomains.length > 0
    ? reportedStagingDomains
    : (preferredDomainValue ? [preferredDomainValue] : [])
  ).join(", ");
  const stagingAuditLogs: (StagingAuditEntry & { actor?: { id: string; fullName?: string | null; email?: string | null; avatarUrl?: string | null } | null })[] = workspace.organizationId
    ? await db.auditLog.findMany({
        where: {
          organizationId: workspace.organizationId,
          resourceType: "site_staging",
          resourceId: workspace.id,
          action: "site_updated"
        },
        orderBy: { createdAt: "desc" },
        take: 25,
        include: {
          actor: {
            select: {
              id: true,
              fullName: true,
              email: true,
              avatarUrl: true
            }
          }
        }
      })
    : [];
  const stagingAuditItems: StagingAuditHistoryItem[] = stagingAuditLogs.map((entry) => {
    const details = entry.details as Record<string, unknown> | null | undefined;
    const actionType = typeof details?.actionType === "string" ? details.actionType : undefined;
    const promoteAttemptId = typeof details?.promoteAttemptId === "string" ? details.promoteAttemptId : undefined;
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
      promoteAttemptId,
      message,
      domains,
      preferredStagingDomain,
      actor: entry.actor ?? undefined
    };
  });
  const latestDomainSyncEntry = getLatestDomainSyncEntry(stagingAuditLogs);
  const latestPromoteOutcome = getLatestPromoteOutcome(stagingAuditLogs);

  const dryRunPlan =
    stagingConfigured && appUuid && stagingCapability
      ? await buildStagingSyncDryRunPlan(appUuid, workspace?.name ?? siteId, stagingCapability)
      : null;
  const actualSyncTestReadiness = getActualSyncTestReadiness({
    stagingConfigured,
    preflightTone: prodToStagingPreflight.tone,
    preflightDetail: prodToStagingPreflight.detail,
    hasDryRunTarget: Boolean(dryRunPlan?.target),
    databaseBehavior: dryRunPlan?.databaseBehavior,
    filesBehavior: dryRunPlan?.filesBehavior
  });

  return (
    <div className="page-stack">
      <PageAutoRefresh intervalMs={12000} />
      {/* Status header */}
      <article className="card">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 600 }}>Staging Environment</h2>
            <p style={{ margin: "0.25rem 0 0", fontSize: "0.85rem", color: "var(--muted)" }}>
              {stagingConfigured
                ? (stagingTargetRunning
                  ? "Staging is active. Validate changes here before promoting to production."
                  : "Staging target is attached and starting up. Refresh in a moment.")
                : stagingEnvironmentReady
                  ? "Staging environment exists, but no staging target is attached yet."
                  : "Staging is not configured for this site."}
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: "0.55rem", marginTop: "0.55rem", flexWrap: "wrap" }}>
              <span className={`status-chip ${stagingEnvironmentReady ? "healthy" : "unknown"}`}>
                {stagingEnvironmentReady ? "Environment created" : "Environment missing"}
              </span>
              <span className={`status-chip ${stagingTargetAttached ? "healthy" : "degraded"}`}>
                {stagingTargetAttached ? "Target attached" : "Target missing"}
              </span>
              {stagingTargetAttached ? (
                <span className={`status-chip ${stagingTargetRunning ? "healthy" : "degraded"}`}>
                  {stagingTargetRunning ? "Target running" : "Target not running"}
                </span>
              ) : null}
            </div>
          </div>
          <span className={`status-chip ${stagingConfigured ? "healthy" : "unknown"}`}>
            {stagingConfigured ? "Enabled" : "Not configured"}
          </span>
        </div>
        {!stagingConfigured && (
          <p style={{ margin: "0.75rem 0 0", fontSize: "0.9rem" }}>
            Enable staging in <Link href={`/apps/${siteId}/settings`} className="action-link">Settings</Link> to trigger Jongo&apos;s auto-provision attempt. If unsupported, provision staging manually in your infrastructure panel and return here.
          </p>
        )}

        {canManageDomains ? (
          <p style={{ margin: "0.75rem 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>
            Admin view: {debugViewEnabled ? "Debug mode is on." : "Debug mode is off."} {debugViewEnabled ? <Link href={disableDebugHref} className="action-link">Hide diagnostics</Link> : <Link href={enableDebugHref} className="action-link">Show diagnostics</Link>}
          </p>
        ) : null}
      </article>

      {stagingConfigured ? (
        <article className="card">
          <h3 className="card-title">Go Live!</h3>
          <p className="card-muted" style={{ marginBottom: "0.75rem" }}>
            Move staging changes to production (live site).
          </p>
          <PromoteToProductionCard
            siteId={siteId}
            disabled={Boolean(promoteLockedReason)}
            disabledReason={promoteLockedReason}
            preflightLabel={stagingToProdPreflight.label}
            preflightTone={stagingToProdPreflight.tone}
          />

          <div style={{ marginTop: "1rem" }}>
            <StagingActionsPanel
              siteId={siteId}
              stagingReady={stagingConfigured}
              canManage={permissionSnapshot.canManageStaging}
            />
          </div>
        </article>
      ) : null}

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
                <CopyTextButton
                  value={`/sites/${siteId}/staging?attemptId=${encodeURIComponent(latestPromoteOutcome.promoteAttemptId)}`}
                  label="Copy deep link"
                />
                <Link
                  href={`/sites/${siteId}/staging?attemptId=${encodeURIComponent(latestPromoteOutcome.promoteAttemptId)}`}
                  className="action-link"
                  style={{ fontSize: "0.8rem" }}
                >
                  Open filtered audit
                </Link>
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

      {latestPromoteOutcome?.actionType === "staging_promote_succeeded" && stagingConfigured ? (
        <article className="card">
          <h3 className="card-title">Post-promotion suggestion</h3>
          <p className="card-muted" style={{ marginBottom: "0.65rem" }}>
            Promotion completed successfully. To conserve resources, you can disable and destroy staging until your next QA cycle.
          </p>
          <p style={{ margin: 0, fontSize: "0.88rem" }}>
            <Link href={`/apps/${siteId}/settings`} className="action-link">Open Settings to disable staging now</Link>
          </p>
        </article>
      ) : null}

      <>
          {stagingConfigured && debugViewEnabled ? (
            <>
          <article className="card">
            <h3 className="card-title">Pre-flight Status</h3>
            <p className="card-muted" style={{ marginBottom: "0.75rem" }}>
              Use these checks to confirm readiness. Production promotion is enabled only when staging-to-production preflight is ready.
            </p>
            <p style={{ margin: "0 0 0.75rem", fontSize: "0.88rem" }}>
              Programmatic testing: <code>GET /api/sites/{siteId}/staging</code> returns sync-readiness and dry-run plan details.
            </p>
            <p style={{ margin: "0 0 0.75rem", fontSize: "0.88rem" }}>
              Promote-attempt lookup: <code>GET /api/sites/{siteId}/staging/promote-attempt?attemptId=&lt;id&gt;</code> returns focused attempt status.
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

          <article className="card">
            <h3 className="card-title">Actual File+DB Sync Test Readiness (Production)</h3>
            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
              <span className={`status-chip ${actualSyncTestReadiness.tone}`}>{actualSyncTestReadiness.label}</span>
              <span style={{ fontSize: "0.82rem", color: "var(--muted)" }}>{actualSyncTestReadiness.summary}</span>
            </div>
            <div style={{ marginTop: "0.75rem", display: "grid", gap: "0.45rem" }}>
              <p style={{ margin: 0, fontSize: "0.84rem", fontWeight: 600 }}>Required checks</p>
              <ul style={{ margin: 0, paddingLeft: "1.2rem", display: "grid", gap: "0.2rem" }}>
                {actualSyncTestReadiness.checks.map((check) => (
                  <li key={check} style={{ fontSize: "0.82rem", color: "var(--muted)" }}>{check}</li>
                ))}
              </ul>
            </div>
            {actualSyncTestReadiness.blockers.length > 0 ? (
              <div style={{ marginTop: "0.75rem", display: "grid", gap: "0.45rem" }}>
                <p style={{ margin: 0, fontSize: "0.84rem", fontWeight: 600 }}>Current blockers</p>
                <ul style={{ margin: 0, paddingLeft: "1.2rem", display: "grid", gap: "0.2rem" }}>
                  {actualSyncTestReadiness.blockers.map((blocker) => (
                    <li key={blocker} style={{ fontSize: "0.82rem", color: "var(--muted)" }}>{blocker}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p className="card-muted" style={{ marginTop: "0.75rem", marginBottom: 0, fontSize: "0.82rem" }}>
              Follow the production readiness workflow in <code>docs/workflows/staging-sync-prod-readiness.md</code> before any live test.
            </p>
          </article>

          {/* Coolify Staging Capability */}
          <article className="card">
            <h3 className="card-title">Staging Capability</h3>
            {!appUuid ? (
              <p className="card-muted" style={{ marginBottom: 0 }}>
                No infrastructure resource linked. Link a service UUID in <Link href={`/apps/${siteId}/settings`} className="action-link">Settings</Link> to detect staging resources.
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
                  <p style={{ margin: 0 }}>Staging resource: <code>{stagingCapability.applicationName}</code></p>
                )}
                {preferredStagingUrl ? (
                  <p style={{ margin: 0 }}>
                    Preferred staging URL: <a href={preferredStagingUrl} target="_blank" rel="noopener noreferrer" className="action-link">{preferredStagingUrl}</a>
                  </p>
                ) : null}
                {preferredStagingUrl && !preferredDomainConverged ? (
                  <p style={{ margin: "0.2rem 0 0", fontSize: "0.82rem", color: "#a15c00" }}>
                    Preferred staging URL is not active yet. Coolify is still serving {reportedStagingDomains[0] ? `https://${reportedStagingDomains[0]}` : "a generated staging host"}. Routing and cert propagation may still be settling.
                  </p>
                ) : null}
                  {reportedStagingDomains.length > 0 && (
                  <div style={{ margin: 0 }}>
                    <p style={{ margin: 0 }}>Actual URL from staging:</p>
                    <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1rem", display: "grid", gap: "0.15rem" }}>
                      {reportedStagingDomains.map((domain) => (
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

                <div
                  style={{
                    display: "grid",
                    gap: "0.45rem",
                    marginTop: "0.9rem",
                    border: "1px solid var(--border)",
                    borderRadius: "10px",
                    background: "var(--surface-alt)",
                    padding: "0.75rem"
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
                    <strong style={{ fontSize: "0.88rem" }}>Production to staging content sync</strong>
                    <span className={`status-chip ${prodToStagingPreflight.tone}`}>{prodToStagingPreflight.label}</span>
                  </div>
                  <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--muted)" }}>
                    This page shows the dry-run plan only. Actual file and database sync runs from infrastructure automation, not from the button flow in Jongo.
                  </p>
                </div>

                <p className="card-muted" style={{ marginTop: "0.75rem", marginBottom: 0, fontSize: "0.82rem" }}>
                  Use this section to review what sync would overwrite. Run the real sync from infrastructure automation before testing staging content.
                </p>
              </article>

              <StagingAuditHistory siteId={siteId} items={stagingAuditItems} initialAttemptId={initialAttemptId} />
            </>
          )}
            </>
          ) : null}

          {!stagingConfigured ? (
            <article className="card">
          <h3 className="card-title">Staging Not Configured</h3>
          <p className="card-muted" style={{ marginBottom: 0 }}>
              The infrastructure API does not currently report a usable staging environment for this app. Sync and promote controls stay hidden until staging is detected.
          </p>
              <p style={{ margin: "0.75rem 0 0", fontSize: "0.9rem" }}>
                Next step: configure staging in <Link href={`/apps/${siteId}/settings`} className="action-link">Settings</Link>, then return here for dry-run preflight and workflow previews.
              </p>
            </article>
          ) : null}
      </>
    </div>
  );
}
