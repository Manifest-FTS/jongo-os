import type { BackupScheduleRecord } from "./coolify";

export type BackupOffsiteStatus = {
  label: string;
  tone: "healthy" | "degraded" | "unknown";
  detail: string;
};

/**
 * Whether an actual restore has been verified recently — distinct from
 * `offsite`, which only reflects Coolify's schedule flag. A backup can be
 * "Configured" offsite yet never proven to restore; this dimension closes that
 * gap. Fed by scripts/verify-jongo-backup.mjs (JONGO_BACKUP_RESULT).
 */
export type BackupRestoreVerification = {
  label: string;
  tone: "healthy" | "degraded" | "unknown";
  status: "verified" | "stale" | "failed" | "never";
  lastVerifiedAt: string | null;
  ageHours: number | null;
  rpoHours: number;
  detail: string;
};

export type BackupRestoreVerificationInput = {
  /** ISO timestamp of the last restore test. */
  lastVerifiedAt?: string | null;
  /** Outcome of that test. */
  lastResult?: "pass" | "fail" | null;
  /** Recovery-point objective in hours (default 26 = daily + slack). */
  rpoHours?: number;
  /** Injectable clock for tests. */
  now?: Date;
};

export type BackupReadModelSnapshot = {
  layerType: "Database";
  ownership: string;
  localStatus: string;
  offsite: BackupOffsiteStatus;
  restoreVerification: BackupRestoreVerification;
  restoreScope: "Database data only";
  stagingSafety: "Not full clone-safe";
  stagingSafetyDetail: string;
};

export function getBackupRestoreVerification(
  input?: BackupRestoreVerificationInput
): BackupRestoreVerification {
  const rpoHours = input?.rpoHours ?? 26;
  const lastVerifiedAt = input?.lastVerifiedAt ?? null;

  if (!lastVerifiedAt) {
    return {
      label: "Never verified",
      tone: "unknown",
      status: "never",
      lastVerifiedAt: null,
      ageHours: null,
      rpoHours,
      detail: "No restore test has been recorded yet. Use “Run restore test” to verify this backup restores cleanly."
    };
  }

  if (input?.lastResult === "fail") {
    return {
      label: "Last restore failed",
      tone: "degraded",
      status: "failed",
      lastVerifiedAt,
      ageHours: null,
      rpoHours,
      detail: "The most recent restore test did not pass. Backups are not proven recoverable."
    };
  }

  const now = input?.now ?? new Date();
  const parsed = Date.parse(lastVerifiedAt);
  const ageHours = Number.isNaN(parsed)
    ? null
    : Math.max(0, Math.floor((now.getTime() - parsed) / 3_600_000));

  if (ageHours === null) {
    return {
      label: "Unknown",
      tone: "unknown",
      status: "never",
      lastVerifiedAt,
      ageHours: null,
      rpoHours,
      detail: "Recorded restore-test timestamp could not be parsed."
    };
  }

  if (ageHours <= rpoHours) {
    return {
      label: `Verified ${ageHours}h ago`,
      tone: "healthy",
      status: "verified",
      lastVerifiedAt,
      ageHours,
      rpoHours,
      detail: `Restore test passed within the ${rpoHours}h recovery-point objective.`
    };
  }

  return {
    label: `Stale (${ageHours}h)`,
    tone: "degraded",
    status: "stale",
    lastVerifiedAt,
    ageHours,
    rpoHours,
    detail: `Last verified restore is ${ageHours}h old, beyond the ${rpoHours}h RPO. Re-run the restore test.`
  };
}

export function getBackupOffsiteStatus(schedules: BackupScheduleRecord[] | undefined): BackupOffsiteStatus {
  const known = (schedules ?? [])
    .map((schedule) => schedule.offsiteEnabled)
    .filter((value): value is boolean => typeof value === "boolean");

  if (known.length === 0) {
    return {
      label: "Unknown",
      tone: "unknown",
      detail: "Offsite replication state is not reported by the current schedule payloads."
    };
  }

  if (known.some((value) => value)) {
    return {
      label: "Configured",
      tone: "healthy",
      detail: "At least one database schedule reports offsite replication enabled."
    };
  }

  return {
    label: "Local only",
    tone: "degraded",
    detail: "Enabled schedules report local retention only. Offsite replication is still required."
  };
}

export function buildBackupReadModelSnapshot(params: {
  ownership: string;
  localStatus: string;
  schedules?: BackupScheduleRecord[];
  restoreVerification?: BackupRestoreVerificationInput;
}): BackupReadModelSnapshot {
  return {
    layerType: "Database",
    ownership: params.ownership,
    localStatus: params.localStatus,
    offsite: getBackupOffsiteStatus(params.schedules),
    restoreVerification: getBackupRestoreVerification(params.restoreVerification),
    restoreScope: "Database data only",
    stagingSafety: "Not full clone-safe",
    stagingSafetyDetail: "Full WordPress clone workflows require files/media coverage and known offsite replication."
  };
}