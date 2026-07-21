import { getCoolifyAppBackupInventory, AppBackupInventory } from "@/lib/coolify";
import { getSiteWorkspace, isClientAdmin } from "@/lib/repositories";
import { getBackupUnavailableMessage } from "@/lib/reason-messages";
import { getBackupReadiness, BACKUP_WARN_AFTER_HOURS, BACKUP_STALE_AFTER_HOURS } from "@/lib/deploy-guards";
import { buildBackupReadModelSnapshot } from "@/lib/backup-read-model";
import { auth } from "@/lib/auth.config";
import RestoreTestButton from "@/components/RestoreTestButton";
import SiteBackupsPanel, { type SiteBackupRow } from "@/components/SiteBackupsPanel";
import Link from "next/link";
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

export default async function BackupsPage({ params }: Params) {
  const { siteId } = await params;
  const session = await auth();
  const workspace = await getSiteWorkspace(siteId, {
    userId: session?.user?.id,
    email: session?.user?.email
  });

  if (!workspace) {
    notFound();
  }

  const canViewInternalMetadata = Boolean(
    session?.user?.id &&
    workspace.organizationId &&
    await isClientAdmin(workspace.organizationId, session.user.id)
  );

  const appUuid = workspace?.coolifyServiceUuid ?? (workspace.source === "coolify" ? workspace.id : undefined);
  const inventory = appUuid ? await getCoolifyAppBackupInventory(appUuid) : null;
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
        const { db } = await import("@/lib/db");
        return db.backupRestoreVerification.findUnique({ where: { resourceUuid: restoreTargetDb.resourceId } });
      })()
    : null;

  // Show the one-click restore test wherever the app has a backed-up database.
  const restoreTestEligible = Boolean(restoreTargetDb?.hasSuccessfulExecution);

  // Jongo-managed full-site backups (files + database, offsite in Backblaze).
  const siteBackupRows: SiteBackupRow[] = workspace.id
    ? await (async () => {
        const { db } = await import("@/lib/db");
        const rows = await db.siteBackup.findMany({
          where: { siteId: workspace.id },
          orderBy: { startedAt: "desc" },
          take: 20
        });
        return rows.map((row: Record<string, unknown>) => ({
          id: String(row.id),
          startedAt: (row.startedAt as Date).toISOString(),
          completedAt: row.completedAt ? (row.completedAt as Date).toISOString() : null,
          status: String(row.status),
          trigger: String(row.trigger),
          label: (row.label as string | null) ?? null,
          posts: (row.posts as number | null) ?? null,
          pages: (row.pages as number | null) ?? null,
          plugins: (row.plugins as number | null) ?? null,
          comments: (row.comments as number | null) ?? null,
          wpVersion: (row.wpVersion as string | null) ?? null,
          restorable: row.status === "success" && Boolean(row.resticSnapshotId),
          error: (row.error as string | null) ?? null
        }));
      })()
    : [];

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

  const diagnosisItems = [
    {
      label: "Backups configured",
      tone: isConfigured ? "healthy" : "error",
      detail: isConfigured
        ? "Automated schedules are configured."
        : "No active backup schedules are configured."
    },
    {
      label: "Successful backup",
      tone: lastSuccessfulBackup ? "healthy" : "error",
      detail: lastSuccessfulBackup
        ? `Last successful backup: ${lastSuccessfulBackup.relativeTime}`
        : "No successful backup found."
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
      tone: backupReadiness.code === "backup_stale" ? "error" : backupReadiness.locked ? "degraded" : "healthy",
      detail: backupReadiness.code === "backup_stale"
        ? `Backup stale. Last success exceeds ${BACKUP_STALE_AFTER_HOURS}h.`
        : `Warning threshold: ${BACKUP_WARN_AFTER_HOURS}h · lock threshold: ${BACKUP_STALE_AFTER_HOURS}h`
    }
  ];

  return (
    <div className="page-stack">
      <article className="card">
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem" }}>
          <div>
            <h2 style={{ marginTop: 0, marginBottom: "0.35rem" }}>Backups</h2>
            <p className="card-muted" style={{ margin: 0 }}>
              Automated database backup schedules and execution history for this app&apos;s databases only.
            </p>
            {canViewInternalMetadata && inventory && (
              <p style={{ margin: "0.4rem 0 0", fontSize: "0.75rem", color: "var(--muted)" }}>
                Platform · checked {formatRelativeTime(inventory.checkedAt)}
                {inventory.source === "unavailable" && <span style={{ color: "var(--error, #c0392b)", marginLeft: "0.3rem" }}>· unavailable</span>}
              </p>
            )}
          </div>
          <span className={`status-chip ${statusChipClass}`}>
            {statusLabel}
          </span>
        </div>
      </article>

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
      ) : !isConfigured ? (
        <article className="card">
          <h3 className="card-title" style={{ color: "var(--warning, #d97706)" }}>Backups not configured</h3>
          <p className="card-muted">No active backup schedules were found for at least one database in this workspace.</p>
          {uncoveredDatabases.length > 0 ? (
            <p className="card-muted" style={{ marginTop: "0.35rem" }}>
              Missing schedules: {uncoveredDatabases.map((entry) => entry.resourceName).join(", ")}
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
        canManage={canViewInternalMetadata}
      />

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
      {isConfigured && hasLiveData ? (
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

      {databaseNames.length > 0 ? (
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

      {hasLiveData ? (
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

      <article className="card">
        <h3 className="card-title">Backup Policy</h3>
        <p className="card-muted" style={{ marginBottom: 0 }}>
          Backup configuration and restoration are managed through the platform for database backups only. WordPress files, media, and staging sync workflows are not covered by this pass. Contact your platform administrator to change schedules, retention policies, or to initiate a recovery.
        </p>
      </article>
    </div>
  );
}
