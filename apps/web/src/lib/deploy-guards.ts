import { AppBackupInventory } from "@/lib/coolify";

export const BACKUP_WARN_AFTER_HOURS = 72;
export const BACKUP_STALE_AFTER_HOURS = 168;

export type BackupGuardCode =
  | "ready"
  | "backup_telemetry_unavailable"
  | "backups_not_applicable"
  | "backups_not_configured"
  | "no_successful_backup"
  | "backup_stale";

export type PreflightTone = "healthy" | "degraded" | "error" | "unknown";

export type BackupReadiness = {
  code: BackupGuardCode;
  locked: boolean;
  reason: string | null;
  nextStep: string | null;
  lastSuccessfulBackupAt: string | null;
  hoursSinceSuccess: number | null;
  warnAfterHours: number;
  staleAfterHours: number;
};

export type PreflightPath = "production-to-staging" | "staging-to-production";

export type PathPreflight = {
  path: PreflightPath;
  tone: PreflightTone;
  label: string;
  detail: string;
};

function getLastSuccessfulBackupAt(inventory: AppBackupInventory): string | null {
  const successful = inventory.recentExecutions.find((item) => item.status === "success" && Boolean(item.finishedAt));
  return successful?.finishedAt ?? null;
}

function getHoursSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60);
}

export function getBackupReadiness(inventory: AppBackupInventory | null, appUuid?: string): BackupReadiness {
  if (!appUuid || !inventory || inventory.source !== "live") {
    return {
      code: "backup_telemetry_unavailable",
      locked: true,
      reason: "Backup telemetry unavailable.",
      nextStep: "Link the app to a valid Coolify UUID and verify backup telemetry is reachable.",
      lastSuccessfulBackupAt: null,
      hoursSinceSuccess: null,
      warnAfterHours: BACKUP_WARN_AFTER_HOURS,
      staleAfterHours: BACKUP_STALE_AFTER_HOURS
    };
  }

  if (inventory.note === "backup_telemetry_unavailable" || inventory.note === "fetch_error") {
    return {
      code: "backup_telemetry_unavailable",
      locked: true,
      reason: "Backup telemetry unavailable.",
      nextStep: "Verify Coolify API token scope, endpoint reachability/allowlist policy, and service-database backup endpoint access.",
      lastSuccessfulBackupAt: null,
      hoursSinceSuccess: null,
      warnAfterHours: BACKUP_WARN_AFTER_HOURS,
      staleAfterHours: BACKUP_STALE_AFTER_HOURS
    };
  }

  // An app with no databases has no backup schedule to configure, so backup
  // readiness cannot be a blocker for it. Without this, every stateless app is
  // permanently deploy- and staging-locked on a condition it can never satisfy,
  // and the lock reason tells the owner to go configure a schedule that does
  // not exist. Derived from live Coolify state, so it covers apps added later
  // with no per-app setup.
  if (inventory.note === "no_databases_in_environment") {
    return {
      code: "backups_not_applicable",
      locked: false,
      reason: "No databases in this app, so there is no backup schedule to configure.",
      nextStep: "",
      lastSuccessfulBackupAt: null,
      hoursSinceSuccess: null,
      warnAfterHours: BACKUP_WARN_AFTER_HOURS,
      staleAfterHours: BACKUP_STALE_AFTER_HOURS
    };
  }

  if (!inventory.configured) {
    return {
      code: "backups_not_configured",
      locked: true,
      reason: "Backups not configured.",
      nextStep: "Configure at least one automated backup schedule in Coolify.",
      lastSuccessfulBackupAt: null,
      hoursSinceSuccess: null,
      warnAfterHours: BACKUP_WARN_AFTER_HOURS,
      staleAfterHours: BACKUP_STALE_AFTER_HOURS
    };
  }

  const lastSuccessfulBackupAt = getLastSuccessfulBackupAt(inventory);
  if (!lastSuccessfulBackupAt) {
    return {
      code: "no_successful_backup",
      locked: true,
      reason: "No successful backup found.",
      nextStep: "Run one successful backup and confirm it appears in Recent Backup Executions.",
      lastSuccessfulBackupAt: null,
      hoursSinceSuccess: null,
      warnAfterHours: BACKUP_WARN_AFTER_HOURS,
      staleAfterHours: BACKUP_STALE_AFTER_HOURS
    };
  }

  const hoursSinceSuccess = getHoursSince(lastSuccessfulBackupAt);
  if (hoursSinceSuccess > BACKUP_STALE_AFTER_HOURS) {
    return {
      code: "backup_stale",
      locked: true,
      reason: "Backup stale.",
      nextStep: `Run a fresh backup. Current age exceeds ${BACKUP_STALE_AFTER_HOURS} hours.`,
      lastSuccessfulBackupAt,
      hoursSinceSuccess,
      warnAfterHours: BACKUP_WARN_AFTER_HOURS,
      staleAfterHours: BACKUP_STALE_AFTER_HOURS
    };
  }

  return {
    code: "ready",
    locked: false,
    reason: null,
    nextStep: hoursSinceSuccess > BACKUP_WARN_AFTER_HOURS
      ? `Backup age warning: older than ${BACKUP_WARN_AFTER_HOURS} hours.`
      : null,
    lastSuccessfulBackupAt,
    hoursSinceSuccess,
    warnAfterHours: BACKUP_WARN_AFTER_HOURS,
    staleAfterHours: BACKUP_STALE_AFTER_HOURS
  };
}

export function getDeployLockReason(inventory: AppBackupInventory | null, appUuid?: string): string | null {
  const readiness = getBackupReadiness(inventory, appUuid);
  if (!readiness.locked) {
    return null;
  }

  return readiness.nextStep
    ? `${readiness.reason} Next step: ${readiness.nextStep}`
    : readiness.reason;
}

export function getPathPreflight(path: PreflightPath, readiness: BackupReadiness, stagingConfigured: boolean): PathPreflight {
  if (!stagingConfigured) {
    return {
      path,
      tone: "error",
      label: "Blocked",
      detail: "Staging is not configured for this app."
    };
  }

  if (readiness.locked) {
    return {
      path,
      tone: "error",
      label: "Locked",
      detail: readiness.reason ?? "Backup readiness is not satisfied."
    };
  }

  if ((readiness.hoursSinceSuccess ?? 0) > readiness.warnAfterHours) {
    return {
      path,
      tone: "degraded",
      label: "Ready with warning",
      detail: `Last successful backup is older than ${readiness.warnAfterHours} hours.`
    };
  }

  return {
    path,
    tone: "healthy",
    label: "Ready",
    detail: "Backup readiness checks are healthy."
  };
}