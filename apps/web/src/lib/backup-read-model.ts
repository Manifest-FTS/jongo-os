import type { BackupScheduleRecord } from "@/lib/coolify";

export type BackupOffsiteStatus = {
  label: string;
  tone: "healthy" | "degraded" | "unknown";
  detail: string;
};

export type BackupReadModelSnapshot = {
  layerType: "Database";
  ownership: string;
  localStatus: string;
  offsite: BackupOffsiteStatus;
  restoreScope: "Database data only";
  stagingSafety: "Not full clone-safe";
  stagingSafetyDetail: string;
};

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
}): BackupReadModelSnapshot {
  return {
    layerType: "Database",
    ownership: params.ownership,
    localStatus: params.localStatus,
    offsite: getBackupOffsiteStatus(params.schedules),
    restoreScope: "Database data only",
    stagingSafety: "Not full clone-safe",
    stagingSafetyDetail: "Full WordPress clone workflows require files/media coverage and known offsite replication."
  };
}