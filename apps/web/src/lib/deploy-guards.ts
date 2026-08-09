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

/**
 * Jongo's own backup history for this app — the restic snapshots it takes
 * itself, as opposed to anything Coolify schedules.
 */
export type JongoBackupState = {
  /** When Jongo last completed a successful backup of this app. */
  lastSuccessAt?: Date | string | null;
};

export function getBackupReadiness(
  inventory: AppBackupInventory | null,
  appUuid?: string,
  jongo?: JongoBackupState | null
): BackupReadiness {
  // Jongo's own backups are consulted FIRST, and they can unlock on their own.
  //
  // This guard exists to answer one question: if the promote goes wrong, can I
  // undo it? A recent Jongo snapshot answers that — it captures files AND the
  // database, which is more than a Coolify database schedule does.
  //
  // Consulting Coolify alone made the guard unsatisfiable for the entire
  // WordPress fleet. Coolify's API cannot see backups for service-embedded
  // databases (see ensureCoolifyAppBackupSchedules), so its telemetry is
  // permanently "unavailable" for those apps and promote could never unlock,
  // however many successful backups Jongo had taken. A safety check that can
  // never pass does not get satisfied, it gets removed — and then nothing
  // guards the promote at all.
  const jongoLast = toIso(jongo?.lastSuccessAt);
  if (jongoLast) {
    const hours = getHoursSince(jongoLast);
    if (hours <= BACKUP_STALE_AFTER_HOURS) {
      return {
        code: "ready",
        locked: false,
        reason: null,
        nextStep: null,
        lastSuccessfulBackupAt: jongoLast,
        hoursSinceSuccess: Math.round(hours),
        warnAfterHours: BACKUP_WARN_AFTER_HOURS,
        staleAfterHours: BACKUP_STALE_AFTER_HOURS
      };
    }
    return {
      code: "backup_stale",
      locked: true,
      reason: `The most recent backup is ${Math.round(hours)}h old.`,
      nextStep: "Take a backup before promoting, so this can be rolled back.",
      lastSuccessfulBackupAt: jongoLast,
      hoursSinceSuccess: Math.round(hours),
      warnAfterHours: BACKUP_WARN_AFTER_HOURS,
      staleAfterHours: BACKUP_STALE_AFTER_HOURS
    };
  }

  // Jongo has never backed this app up. Say THAT, rather than blaming Coolify
  // API scope — the operator's next step is one button, not a support ticket.
  if (jongo) {
    return {
      code: "no_successful_backup",
      locked: true,
      reason: "This app has never been backed up, so a promotion could not be rolled back.",
      nextStep: "Take a backup from the Backups tab, then promote.",
      lastSuccessfulBackupAt: null,
      hoursSinceSuccess: null,
      warnAfterHours: BACKUP_WARN_AFTER_HOURS,
      staleAfterHours: BACKUP_STALE_AFTER_HOURS
    };
  }

  return getCoolifyBackupReadiness(inventory, appUuid);
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** The original Coolify-only rule, kept for callers with no Jongo state. */
function getCoolifyBackupReadiness(inventory: AppBackupInventory | null, appUuid?: string): BackupReadiness {
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