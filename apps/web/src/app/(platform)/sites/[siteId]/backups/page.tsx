import { getCoolifyAppBackupInventory, describeCoolifyBackupCapability, AppBackupInventory } from "@/lib/coolify";
import { describeRestorability } from "@/lib/backup-restorability";
import { getSiteWorkspace, isClientAdmin } from "@/lib/repositories";
import { getBackupUnavailableMessage } from "@/lib/reason-messages";
import { getBackupReadiness, BACKUP_WARN_AFTER_HOURS, BACKUP_STALE_AFTER_HOURS } from "@/lib/deploy-guards";
import { buildBackupReadModelSnapshot } from "@/lib/backup-read-model";
import { resolveSitePermissionSnapshot } from "@/lib/permissions";
import { auth } from "@/lib/auth.config";
import RestoreTestButton from "@/components/RestoreTestButton";
import SiteBackupsPanel, { type SiteBackupRow } from "@/components/SiteBackupsPanel";
import { scheduledBackupsDefaultEnabled, summarizeBackupSchedule } from "@/lib/backup-schedule";
import { buildBackupDiagnosis } from "@/lib/backup-diagnosis";
import { resolveBackupViewCapability } from "@/lib/backup-view-capability";
import { type StackMarkers } from "@/lib/backup-stack";
import Link from "next/link";
import { notFound } from "next/navigation";

type Params = {
  params: Promise<{ siteId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * Pull the stack markers out of a SiteBackup.contentSummary column.
 *
 * The column holds `{ stack, markers }` and is JSON, so it can be anything —
 * including a shape written by a future version. Anything unexpected reads as
 * "no markers", which falls the row back to the WordPress columns rather than
 * throwing while rendering someone's backup list.
 */
function extractContentMarkers(value: unknown): StackMarkers | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const markers = (value as { markers?: unknown }).markers;
  if (!markers || typeof markers !== "object" || Array.isArray(markers)) return null;
  return markers as StackMarkers;
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function getLastSuccessfulBackup(inventory: AppBackupInventory | null): { timestamp: string; relativeTime: string } | null {
  if (!inventory?.recentExecutions || inventory.recentExecutions.length === 0) return null;
  const successful = inventory.recentExecutions.find((exec) => exec.status === "success");
  if (!successful || !successful.finishedAt) return null;
  return {
    timestamp: successful.finishedAt,
    relativeTime: formatRelativeTime(successful.finishedAt)
  };
}

function getHoursAgo(iso: string): number {
  const diff = Date.now() - new Date(iso).getTime();
  return diff / (3_600_000);
}

function getDaysAgo(iso: string): number {
  return getHoursAgo(iso) / 24;
}

function isBackupStale(lastBackup: string | null, retentionDays?: number): boolean {
  if (!lastBackup) return true;
  const daysOld = getDaysAgo(lastBackup);
  const staleThreshold = Math.max(retentionDays ?? 7, 7); // At least 7 days for freshness
  return daysOld > staleThreshold;
}

function hasFailureChain(inventory: AppBackupInventory | null): boolean {
  if (!inventory?.recentExecutions || inventory.recentExecutions.length < 3) return false;
  const lastThree = inventory.recentExecutions.slice(0, 3);
  return lastThree.every((exec) => exec.status === "failed");
}

function isRunningBackup(inventory: AppBackupInventory | null): boolean {
  if (!inventory?.recentExecutions || inventory.recentExecutions.length === 0) return false;
  return inventory.recentExecutions.some((exec) => exec.status === "running");
}

function getProtectionStatus(
  hasLiveData: boolean,
  isConfigured: boolean,
  lastBackup: string | null,
  retentionDays?: number
): "protected-recent" | "protected-stale" | "unprotected" | "unknown" {
  if (!hasLiveData) return "unknown";
  if (!isConfigured) return "unprotected";
  if (!lastBackup) return "unprotected";
  if (isBackupStale(lastBackup, retentionDays)) return "protected-stale";
  return "protected-recent";
}

export default async function BackupsPage({ params, searchParams }: Params) {
  const { siteId } = await params;
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

  const canViewInternalMetadata = Boolean(
    session?.user?.id &&
    workspace.organizationId &&
    await isClientAdmin(workspace.organizationId, session.user.id)
  );
  const showAdminBackupDiagnostics = permissionSnapshot.isAdmin || canViewInternalMetadata;

  const appUuid = workspace?.coolifyServiceUuid ?? (workspace.source === "coolify" ? workspace.id : undefined);
  const inventory = appUuid ? await getCoolifyAppBackupInventory(appUuid) : null;

  // Which metric columns a row shows is decided per row, from the markers the
  // backup itself recorded — see SiteBackupsPanel. This page used to also ask
  // Coolify whether the resource was WordPress and then never read the answer,
  // which cost an API call per render and, because that probe rethrows on a
  // rate limit rather than lying, was the one call here that could take the
  // whole page down with a 500. Removed rather than wrapped: nothing read it.

  // Staging resources are restored from their production counterpart, so they
  // do not get their own backups. Flag is maintained by the hourly reconciler.
  const isStagingResource = Boolean(workspace.isStagingResource);

  // Prefer the answer the reconciler cached: it costs no Coolify call, and this
  // page probing live on every render is what made a rate-limited moment look
  // like "this app has nothing to back up". Only probe when nothing is cached.
  const cachedCapability = await (async () => {
    try {
      const { getDb } = await import("@/lib/db");
      const prisma = await getDb();
      if (!prisma) return null;
      return await (prisma as any).site.findUnique({
        where: { id: workspace.id },
        select: { backupEligible: true, backupCapabilityReason: true }
      });
    } catch {
      return null;
    }
  })();

  const needsLiveProbe =
    !isStagingResource &&
    Boolean(appUuid) &&
    (typeof cachedCapability?.backupEligible !== "boolean" ||
      !cachedCapability?.backupCapabilityReason ||
      cachedCapability.backupCapabilityReason === "unknown");

  const liveCapability = needsLiveProbe && appUuid
    ? await describeCoolifyBackupCapability(appUuid)
    : null;

  const view = resolveBackupViewCapability({
    cachedBackupable: cachedCapability?.backupEligible ?? null,
    cachedReason: cachedCapability?.backupCapabilityReason ?? null,
    liveBackupable: liveCapability?.backupable ?? null,
    liveReason: liveCapability?.reason ?? null,
    isStagingResource
  });

  const capability = { backupable: view.backupable, reason: view.reason, externalHost: liveCapability?.externalHost };
  const hasBackupableState = view.backupable;
  // Show the section when there is something to show, and allow the action
  // whenever we are not certain there is nothing — the create API arbitrates.
  const isBackupable = view.showBackupFeatures;
  const allowBackupAction = view.allowBackupAction;
  const backupReadiness = getBackupReadiness(inventory, appUuid);

  const isConfigured = inventory?.configured ?? false;
  const hasLiveData = inventory?.source === "live";
  const enabledSchedules = inventory?.schedules.filter((s) => s.enabled) ?? [];
  const recentExecutions = inventory?.recentExecutions ?? [];
  const databaseCoverage = inventory?.databaseCoverage ?? [];
  const uncoveredDatabases = databaseCoverage.filter((entry) => !entry.hasSchedule);

  // The database this app's restore test targets (prefer one with a real backup).
  const restoreTargetDb =
    databaseCoverage.find((entry) => entry.hasSuccessfulExecution) ??
    databaseCoverage.find((entry) => entry.hasSchedule) ??
    databaseCoverage[0];
  const lastSuccessfulBackup = getLastSuccessfulBackup(inventory);
  const failureChain = hasFailureChain(inventory);
  const backupRunning = isRunningBackup(inventory);

  // Group schedules by database name
  const schedulesByDatabase = enabledSchedules.reduce(
    (acc, schedule) => {
      const dbName = schedule.resourceName || "Unknown Database";
      if (!acc[dbName]) {
        acc[dbName] = [];
      }
      acc[dbName].push(schedule);
      return acc;
    },
    {} as Record<string, typeof enabledSchedules>
  );

  const databaseNames = Object.keys(schedulesByDatabase);
  const latestExecutionByDatabase = new Map<string, (typeof recentExecutions)[number]>();
  for (const execution of recentExecutions) {
    const key = execution.resourceName?.trim();
    if (!key) {
      continue;
    }
    if (!latestExecutionByDatabase.has(key)) {
      latestExecutionByDatabase.set(key, execution);
    }
  }
  const maxRetentionDays = Math.max(
    ...databaseNames.map((dbName) =>
      Math.max(...(schedulesByDatabase[dbName].map((s) => s.retentionDays ?? 7) ?? [7]))
    ),
    7
  );

  const protectionStatus = getProtectionStatus(
    hasLiveData,
    isConfigured,
    lastSuccessfulBackup?.timestamp ?? null,
    maxRetentionDays
  );

  const statusChipClass =
    protectionStatus === "protected-recent"
      ? "healthy"
      : protectionStatus === "protected-stale"
        ? "degraded"
        : protectionStatus === "unprotected"
          ? "error"
          : "unknown";

  const statusLabel =
    protectionStatus === "protected-recent"
      ? "Protected (recent)"
      : protectionStatus === "protected-stale"
        ? "Protected (stale)"
        : protectionStatus === "unprotected"
          ? "Not protected"
          : "Status unknown";

  // Restore-test outcome recorded by scripts/restore-test-resource.mjs, keyed by
  // the DB resource UUID it tested. Absent → chip shows "Never verified".
  const restoreVerificationRecord = restoreTargetDb
    ? await (async () => {
        const { getDb } = await import("@/lib/db");
        const prisma = await getDb();

        if (!prisma || !("backupRestoreVerification" in prisma)) {
          return null;
        }

        try {
          return await (prisma as any).backupRestoreVerification.findUnique({
            where: { resourceUuid: restoreTargetDb.resourceId }
          });
        } catch {
          return null;
        }
      })()
    : null;

  // Show the one-click restore test wherever the app has a backed-up database.
  const restoreTestEligible = Boolean(restoreTargetDb?.hasSuccessfulExecution);

  // Jongo-managed full-site backups (files + database, offsite in Backblaze).
  const backupPageSize = 10;
  const requestedPage = Number((await searchParams)?.bkPage ?? 1);
  const backupPage = Number.isFinite(requestedPage) && requestedPage > 0 ? Math.floor(requestedPage) : 1;

  // Watchdog: a backup whose result callback never arrived would otherwise sit
  // in "running" forever. Anything still running after 30 minutes is treated as
  // failed so the UI can never hang indefinitely.
  if (workspace.id) {
    const { getDb } = await import("@/lib/db");
    const prisma = await getDb();

    if (prisma && "siteBackup" in prisma) {
      try {
        await (prisma as any).siteBackup.updateMany({
          where: {
            siteId: workspace.id,
            status: "running",
            startedAt: { lt: new Date(Date.now() - 30 * 60 * 1000) }
          },
          data: {
            status: "failed",
            error: "timed_out",
            completedAt: new Date()
          }
        });
      } catch {
        // Degrade safely if schema drift or table access is unavailable.
      }
    }
  }

  const backupTotal: number = workspace.id
    ? await (async () => {
        const { getDb } = await import("@/lib/db");
        const prisma = await getDb();
        if (!prisma || !("siteBackup" in prisma)) {
          return 0;
        }

        try {
          return await (prisma as any).siteBackup.count({ where: { siteId: workspace.id } });
        } catch {
          return 0;
        }
      })()
    : 0;

  const siteBackupRows: SiteBackupRow[] = workspace.id
    ? await (async () => {
        const { getDb } = await import("@/lib/db");
        const prisma = await getDb();
        if (!prisma || !("siteBackup" in prisma)) {
          return [];
        }

        let rows: Array<Record<string, unknown>> = [];
        try {
          rows = await (prisma as any).siteBackup.findMany({
            where: { siteId: workspace.id },
            orderBy: { startedAt: "desc" },
            skip: (backupPage - 1) * backupPageSize,
            take: backupPageSize
          });
        } catch {
          return [];
        }

        return rows.map((row: Record<string, unknown>) => ({
          id: String(row.id),
          startedAt: (row.startedAt as Date).toISOString(),
          completedAt: row.completedAt ? (row.completedAt as Date).toISOString() : null,
          status: String(row.status),
          trigger: String(row.trigger),
          label: (row.label as string | null) ?? null,
          resourceType: (row.resourceType as string | null) ?? null,
          volumeCount: (row.volumeCount as number | null) ?? null,
          databaseCount: (row.databaseCount as number | null) ?? null,
          databaseTables: (row.databaseTables as number | null) ?? null,
          sizeBytes: row.sizeBytes !== null && row.sizeBytes !== undefined ? Number(row.sizeBytes) : null,
          posts: (row.posts as number | null) ?? null,
          pages: (row.pages as number | null) ?? null,
          plugins: (row.plugins as number | null) ?? null,
          comments: (row.comments as number | null) ?? null,
          wpVersion: (row.wpVersion as string | null) ?? null,
          // Markers recorded by the stack recipe. Null for backups taken before
          // it existed — those still render from the WordPress columns above.
          contentMarkers: extractContentMarkers(row.contentSummary),
          restorable: describeRestorability({
            status: typeof row.status === "string" ? row.status : null,
            resticSnapshotId: typeof row.resticSnapshotId === "string" ? row.resticSnapshotId : null
          }).restorable,
          error: (row.error as string | null) ?? null,
          restoreStatus: (row.restoreStatus as string | null) ?? null,
          restoreError: (row.restoreError as string | null) ?? null
        }));
      })()
    : [];

  // Read the schedule straight from the row rather than threading it through
  // SiteWorkspaceRecord — a missing field in one of that type's select blocks
  // fails silently as `undefined`, which would quietly show "off" to a customer
  // whose backups are actually on.
  const scheduleSummary = await (async () => {
    try {
      const { getDb } = await import("@/lib/db");
      const prisma = await getDb();
      if (!prisma) return null;
      const row = await (prisma as any).site.findUnique({
        where: { id: workspace.id },
        select: {
          backupScheduleEnabled: true,
          backupFrequencyHours: true,
          lastScheduledBackupAt: true
        }
      });
      if (!row) return null;
      return summarizeBackupSchedule({
        ...row,
        platformDefaultEnabled: scheduledBackupsDefaultEnabled()
      });
    } catch {
      return null;
    }
  })();

  const ownershipLabel = `${workspace.clientName} / ${workspace.name}`;
  const readModel = buildBackupReadModelSnapshot({
    ownership: ownershipLabel,
    localStatus: statusLabel,
    schedules: enabledSchedules,
    restoreVerification: restoreVerificationRecord
      ? {
          lastVerifiedAt: restoreVerificationRecord.lastVerifiedAt.toISOString(),
          lastResult: restoreVerificationRecord.lastResult === "pass" ? "pass" : "fail",
          rpoHours: restoreVerificationRecord.rpoHours
        }
      : undefined
  });

  // One verdict drives every backup-health claim on this page, so the cards
  // cannot contradict each other. Derived from the app's live capability, so a
  // newly added app is classified with no per-app setup.
  // Split the missing schedules by whether Coolify could create them at all.
  // Its API only schedules standalone databases, so a WordPress stack's
  // embedded MariaDB can never have one — telling the owner to go and
  // configure it is an instruction nobody can follow.
  const missingUnschedulable = uncoveredDatabases.filter((entry) => entry.source === "embedded_service").length;
  const missingSchedulable = uncoveredDatabases.length - missingUnschedulable;

  const diagnosis = buildBackupDiagnosis({
    backupable: hasBackupableState,
    capabilityReason: capability.reason,
    isStagingResource,
    isConfigured,
    hasSuccessfulBackup: Boolean(lastSuccessfulBackup),
    missingSchedulable,
    missingUnschedulable
  });

  const diagnosisItems = [
    {
      label: "Backups configured",
      tone: diagnosis.configuredTone,
      detail: diagnosis.configuredDetail
    },
    {
      label: "Successful backup",
      tone: diagnosis.successTone,
      detail: lastSuccessfulBackup
        ? `Last successful backup: ${lastSuccessfulBackup.relativeTime}`
        : diagnosis.applicable
          ? "No successful backup found."
          : diagnosis.notApplicableDetail
    },
    {
      label: "Backup telemetry",
      tone: hasLiveData ? "healthy" : "unknown",
      detail: hasLiveData
        ? "Live backup telemetry available."
        : "Backup telemetry unavailable."
    },
    {
      label: "Backup freshness",
      // "Healthy" would be a lie for an app that has no backups to be fresh.
      tone: !diagnosis.applicable
        ? "unknown"
        : backupReadiness.code === "backup_stale"
          ? "error"
          : backupReadiness.locked
            ? "degraded"
            : "healthy",
      detail: !diagnosis.applicable
        ? diagnosis.notApplicableDetail
        : backupReadiness.code === "backup_stale"
          ? `Backup stale. Last success exceeds ${BACKUP_STALE_AFTER_HOURS}h.`
          : `Warning threshold: ${BACKUP_WARN_AFTER_HOURS}h · lock threshold: ${BACKUP_STALE_AFTER_HOURS}h`
    }
  ];

  return (
    <div className="page-stack">
      {!appUuid ? (
        <article className="card">
          <h3 className="card-title">No infrastructure resource linked</h3>
          <p className="card-muted" style={{ marginBottom: 0 }}>
            Link an infrastructure resource in Settings to view backup status.
          </p>
        </article>
      ) : !hasLiveData ? (
        <article className="card">
          <h3 className="card-title">Backup data unavailable</h3>
          <p className="card-muted">
            {getBackupUnavailableMessage(inventory?.note)}
          </p>
          {canViewInternalMetadata && (
            <p style={{ margin: "0.65rem 0 0", fontSize: "0.88rem" }}>
              <Link href="/settings" className="action-link">Open platform settings to verify deployment configuration</Link>
            </p>
          )}
        </article>
      ) : diagnosis.showNotConfiguredAlarm && showAdminBackupDiagnostics ? (
        <article className="card">
          <h3 className="card-title" style={{ color: "var(--warning, #d97706)" }}>Backups not configured</h3>
          <p className="card-muted">No active backup schedules were found for at least one database in this workspace.</p>
          {/* Only the databases Coolify could actually schedule. Listing an
              embedded service database here named a thing the reader has no
              way to fix. */}
          {uncoveredDatabases.some((entry) => entry.source !== "embedded_service") ? (
            <p className="card-muted" style={{ marginTop: "0.35rem" }}>
              Missing schedules:{" "}
              {uncoveredDatabases
                .filter((entry) => entry.source !== "embedded_service")
                .map((entry) => entry.resourceName)
                .join(", ")}
            </p>
          ) : null}
          <p className="card-muted" style={{ marginBottom: 0 }}>
            {inventory?.note === "no_databases_in_environment"
              ? "No databases were detected in this application's environment."
              : "Contact your platform administrator to configure automated database backups."}
          </p>
          {canViewInternalMetadata && (
            <p style={{ margin: "0.65rem 0 0", fontSize: "0.88rem" }}>
              <Link href={`/apps/${siteId}/settings`} className="action-link">Open app settings to verify resource mapping</Link>
            </p>
          )}
        </article>
      ) : null}

      <SiteBackupsPanel
        siteId={siteId}
        backups={siteBackupRows}
        canCreateBackup={permissionSnapshot.canCreateBackup && allowBackupAction}
        canAnnotateBackup={permissionSnapshot.canAnnotateBackup}
        canRestoreBackup={permissionSnapshot.canRestoreBackup && allowBackupAction}
        canDownloadBackup={permissionSnapshot.canDownloadBackup}
        supported={isBackupable}
        unsupportedReason={
          isStagingResource
            ? "staging"
            : capability.reason === "external_database"
              ? "external_database"
              : "no_state"
        }
        externalDatabaseHost={"externalHost" in capability ? capability.externalHost : undefined}
        schedule={scheduleSummary}
        unverifiedNote={view.unverifiedNote}
        page={backupPage}
        pageSize={backupPageSize}
        total={backupTotal}
      />

      {showAdminBackupDiagnostics ? (
        <article className="card">
          <h3 className="card-title">Backup Read Model Snapshot</h3>
          <p className="card-muted" style={{ marginBottom: "0.75rem" }}>
            Read-only backup interpretation for this app workspace.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "0.65rem" }}>
            <div style={{ border: "1px solid var(--border)", borderRadius: "8px", padding: "0.6rem 0.75rem" }}>
              <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--muted)" }}>Layer type</p>
              <p style={{ margin: "0.2rem 0 0", fontSize: "0.9rem", fontWeight: 600 }}>{readModel.layerType}</p>
            </div>
            <div style={{ border: "1px solid var(--border)", borderRadius: "8px", padding: "0.6rem 0.75rem" }}>
              <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--muted)" }}>Ownership</p>
              <p style={{ margin: "0.2rem 0 0", fontSize: "0.9rem", fontWeight: 600 }}>{readModel.ownership}</p>
            </div>
            <div style={{ border: "1px solid var(--border)", borderRadius: "8px", padding: "0.6rem 0.75rem" }}>
              <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--muted)" }}>Local status</p>
              <p style={{ margin: "0.2rem 0 0", fontSize: "0.9rem", fontWeight: 600 }}>{readModel.localStatus}</p>
            </div>
            {canViewInternalMetadata && (
              <>
                <div style={{ border: "1px solid var(--border)", borderRadius: "8px", padding: "0.6rem 0.75rem" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem" }}>
                    <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--muted)" }}>Offsite status</p>
                    <span className={`status-chip ${readModel.offsite.tone}`}>{readModel.offsite.label}</span>
                  </div>
                  <p style={{ margin: "0.35rem 0 0", fontSize: "0.78rem", color: "var(--muted)" }}>{readModel.offsite.detail}</p>
                </div>
                <div style={{ border: "1px solid var(--border)", borderRadius: "8px", padding: "0.6rem 0.75rem" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem" }}>
                    <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--muted)" }}>Restore verified</p>
                    <span className={`status-chip ${readModel.restoreVerification.tone}`}>
                      {readModel.restoreVerification.label}
                    </span>
                  </div>
                  <p style={{ margin: "0.35rem 0 0", fontSize: "0.78rem", color: "var(--muted)" }}>
                    {readModel.restoreVerification.detail}
                  </p>
                  {restoreTestEligible ? (
                    <div style={{ marginTop: "0.6rem" }}>
                      <RestoreTestButton siteId={siteId} />
                    </div>
                  ) : null}
                </div>
                <div style={{ border: "1px solid var(--border)", borderRadius: "8px", padding: "0.6rem 0.75rem" }}>
                  <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--muted)" }}>Restore scope</p>
                  <p style={{ margin: "0.2rem 0 0", fontSize: "0.9rem", fontWeight: 600 }}>{readModel.restoreScope}</p>
                </div>
                <div style={{ border: "1px solid var(--border)", borderRadius: "8px", padding: "0.6rem 0.75rem" }}>
                  <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--muted)" }}>Staging safety</p>
                  <p style={{ margin: "0.2rem 0 0", fontSize: "0.9rem", fontWeight: 600 }}>{readModel.stagingSafety}</p>
                  <p style={{ margin: "0.35rem 0 0", fontSize: "0.78rem", color: "var(--muted)" }}>
                    {readModel.stagingSafetyDetail}
                  </p>
                </div>
              </>
            )}
          </div>
        </article>
      ) : null}

      {canViewInternalMetadata && databaseCoverage.length > 0 ? (
        <article className="card">
          <h3 className="card-title">Database Coverage</h3>
          <p className="card-muted" style={{ marginBottom: "0.75rem" }}>
            Read-only visibility of which databases currently have scheduled backups.
          </p>
          <div style={{ display: "grid", gap: "0.55rem" }}>
            {databaseCoverage.map((entry) => (
              <div key={entry.resourceId} style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "center" }}>
                <div>
                  <p style={{ margin: 0, fontSize: "0.88rem" }}>{entry.resourceName}</p>
                  <p style={{ margin: "0.16rem 0 0", fontSize: "0.78rem", color: "var(--muted)" }}>
                    {entry.engine} · {entry.source === "standalone_database" ? "standalone" : "embedded service"}
                    {entry.note ? ` · ${entry.note}` : ""}
                  </p>
                </div>
                <span className={`status-chip ${entry.hasSchedule ? "healthy" : "error"}`}>
                  {entry.hasSchedule ? "scheduled" : "missing schedule"}
                </span>
              </div>
            ))}
          </div>
        </article>
      ) : null}

      {/* Last Successful Backup Status */}
      {showAdminBackupDiagnostics && isConfigured && hasLiveData ? (
        <article className="card" style={{ borderLeft: `4px solid var(--${statusChipClass === "error" ? "error" : statusChipClass === "degraded" ? "warning" : "success"}, #00c853)` }}>
          <h3 className="card-title" style={{ marginBottom: "0.5rem" }}>Recent Backup Status</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBottom: "0.5rem" }}>
            <div>
              <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--muted)" }}>Last Successful Backup</p>
              <p style={{ margin: "0.2rem 0 0", fontSize: "1rem", fontWeight: 600 }}>
                {lastSuccessfulBackup ? lastSuccessfulBackup.relativeTime : "Never"}
              </p>
            </div>
            <div>
              <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--muted)" }}>Retention Policy</p>
              <p style={{ margin: "0.2rem 0 0", fontSize: "1rem", fontWeight: 600 }}>
                {maxRetentionDays >= 7 ? `${maxRetentionDays} days` : `${maxRetentionDays} days (⚠ short)`}
              </p>
            </div>
          </div>
          {canViewInternalMetadata && (
            <p style={{ margin: "0.35rem 0 0", fontSize: "0.8rem", color: "var(--muted)" }}>
              Freshness thresholds: warn after {BACKUP_WARN_AFTER_HOURS}h, lock after {BACKUP_STALE_AFTER_HOURS}h.
            </p>
          )}
          {failureChain && (
            <div style={{ padding: "0.6rem 0.75rem", background: "var(--error, #c0392b)", borderRadius: "4px", marginTop: "0.5rem" }}>
              <p style={{ margin: 0, fontSize: "0.82rem", color: "white", fontWeight: 500 }}>
                ⚠ Last 3 backups failed. Check platform logs for errors.
              </p>
            </div>
          )}
          {backupRunning && (
            <div style={{ padding: "0.6rem 0.75rem", background: "var(--info, #2196f3)", borderRadius: "4px", marginTop: "0.5rem" }}>
              <p style={{ margin: 0, fontSize: "0.82rem", color: "white", fontWeight: 500 }}>
                ⓘ Backup in progress...
              </p>
            </div>
          )}
        </article>
      ) : null}

      {canViewInternalMetadata && (
        <article className="card">
          <h3 className="card-title">Readiness Diagnosis</h3>
          <p className="card-muted" style={{ marginBottom: "0.75rem" }}>
            Use this to identify whether deploy/sync locks are caused by configuration, failed backups, telemetry outage, or stale backups.
          </p>
          <div style={{ display: "grid", gap: "0.6rem" }}>
            {diagnosisItems.map((item) => (
              <div key={item.label} style={{ border: "1px solid var(--border)", borderRadius: "8px", padding: "0.6rem 0.75rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" }}>
                  <strong style={{ fontSize: "0.88rem" }}>{item.label}</strong>
                  <span className={`status-chip ${item.tone}`}>{item.tone === "healthy" ? "OK" : item.tone === "error" ? "Action needed" : "Check"}</span>
                </div>
                <p style={{ margin: "0.35rem 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>{item.detail}</p>
              </div>
            ))}
          </div>
          {backupReadiness.nextStep ? (
            <p style={{ margin: "0.75rem 0 0", fontSize: "0.85rem" }}>
              <strong>Next step:</strong> {backupReadiness.nextStep}
            </p>
          ) : null}
        </article>
      )}

      {showAdminBackupDiagnostics && databaseNames.length > 0 ? (
        <article className="card">
          <h3 className="card-title">Database Backup Schedules</h3>
          <div style={{ display: "grid", gap: "0.75rem", marginTop: "0.5rem" }}>
            {databaseNames.map((dbName) => {
              const dbSchedules = schedulesByDatabase[dbName];
              const latestExecution = latestExecutionByDatabase.get(dbName);
              return (
                <div key={dbName} style={{ padding: "0.75rem", background: "var(--surface-alt)", borderRadius: "8px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", marginBottom: "0.5rem" }}>
                    <div>
                      <p style={{ margin: 0, fontWeight: 600, fontSize: "0.9rem" }}>{dbName}</p>
                      <p style={{ margin: "0.2rem 0 0", fontSize: "0.82rem", color: "var(--muted)" }}>
                        {dbSchedules.length} schedule{dbSchedules.length !== 1 ? "s" : ""}
                      </p>
                    </div>
                    <span className="status-chip healthy">enabled</span>
                  </div>
                  {canViewInternalMetadata && latestExecution ? (
                    <p style={{ margin: "0 0 0.4rem", fontSize: "0.8rem", color: "var(--muted)" }}>
                      Latest execution: {formatRelativeTime(latestExecution.finishedAt ?? latestExecution.startedAt ?? inventory?.checkedAt ?? new Date().toISOString())}
                    </p>
                  ) : null}
                  <div style={{ display: "grid", gap: "0.3rem", fontSize: "0.82rem", color: "var(--muted)" }}>
                    {dbSchedules.map((s, idx) => (
                      <div key={idx}>
                        <span>
                          {s.frequency ? `Schedule: ${s.frequency}` : "Schedule: custom"}
                          {s.retentionAmount != null ? ` · ${s.retentionAmount} backups` : ""}
                          {s.retentionDays != null ? ` · ${s.retentionDays}d retention` : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </article>
      ) : null}

      {showAdminBackupDiagnostics && hasLiveData ? (
        <article className="card">
          <h3 className="card-title">Recent Backup Executions</h3>
          {recentExecutions.length === 0 ? (
            <p className="card-muted" style={{ marginBottom: 0 }}>No backup execution records found.</p>
          ) : (
            <div style={{ display: "grid", gap: "0.5rem", marginTop: "0.5rem" }}>
              {recentExecutions.map((exec) => (
                <div key={exec.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.65rem" }}>
                  <div>
                    {exec.resourceName ? (
                      <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--muted)" }}>{exec.resourceName}</p>
                    ) : null}
                    <p style={{ margin: 0, fontSize: "0.88rem" }}>
                      {exec.finishedAt
                        ? formatRelativeTime(exec.finishedAt)
                        : exec.startedAt
                          ? formatRelativeTime(exec.startedAt)
                          : "unknown time"}
                    </p>
                    {canViewInternalMetadata && exec.filename ? (
                      <p style={{ margin: "0.1rem 0 0", fontSize: "0.78rem", color: "var(--muted)" }}>{exec.filename}</p>
                    ) : null}
                    {exec.sizeBytes ? (
                      <p style={{ margin: "0.1rem 0 0", fontSize: "0.78rem", color: "var(--muted)" }}>
                        Size: {(exec.sizeBytes / (1024 * 1024)).toFixed(2)} MB
                      </p>
                    ) : null}
                    {canViewInternalMetadata && (
                      <p style={{ margin: "0.18rem 0 0", fontSize: "0.78rem", color: "var(--muted)" }}>
                        Download and restore actions are not exposed in Jongo in this pass.
                      </p>
                    )}
                  </div>
                  <span className={`status-chip ${exec.status === "success" ? "healthy" : exec.status === "failed" ? "error" : exec.status === "running" ? "unknown" : "unknown"}`}>
                    {exec.status}
                  </span>
                </div>
              ))}
            </div>
          )}
          <p className="card-muted" style={{ marginTop: "0.75rem", marginBottom: 0, fontSize: "0.82rem" }}>
            Restore operations must be performed via the platform dashboard by an administrator.
          </p>
        </article>
      ) : null}

      {showAdminBackupDiagnostics ? (
        <article className="card">
          <h3 className="card-title">Backup Policy</h3>
          <p className="card-muted" style={{ marginBottom: 0 }}>
            Backup configuration and restoration are managed through the platform for database backups only. WordPress files, media, and staging sync workflows are not covered by this pass. Contact your platform administrator to change schedules, retention policies, or to initiate a recovery.
          </p>
        </article>
      ) : null}
    </div>
  );
}
