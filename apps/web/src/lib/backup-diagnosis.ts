/**
 * Whether "backups" is even a meaningful health question for this app.
 *
 * The backups page grew several independent verdicts: a Coolify-schedule check,
 * a last-successful-backup check, and the capability check. Only the last one
 * knows whether the app has any data, so a stateless app was shown an orange
 * "Backups not configured — verify resource mapping" alarm directly above an
 * accurate "Nothing to back up for this app". Two cards, same app, opposite
 * conclusions, and the alarming one was the wrong one.
 *
 * The rule encoded here: an app with nothing to back up is not unhealthy. It is
 * not "unconfigured", it is not missing a successful backup, and it does not
 * need its resource mapping checked. Alarming on it is how people learn to
 * ignore alarms that matter.
 *
 * Everything is derived from the app's live capability, so a newly added app is
 * classified correctly with no per-app configuration.
 */

export type DiagnosisTone = "healthy" | "degraded" | "error" | "unknown";

export type BackupCapabilityReason =
  | "service_containers"
  | "standalone_database"
  | "persistent_volumes"
  | "linked_database"
  | "external_database"
  | "stateless"
  | "unknown";

export type BackupDiagnosis = {
  /** False when backup health is not a meaningful question for this app. */
  applicable: boolean;
  /** Whether to show the "Backups not configured" alarm at all. */
  showNotConfiguredAlarm: boolean;
  /** Neutral one-liner when not applicable; empty otherwise. */
  notApplicableDetail: string;
  /** Tone for the "Backups configured" row. */
  configuredTone: DiagnosisTone;
  configuredDetail: string;
  /** Tone for the "Successful backup" row. */
  successTone: DiagnosisTone;
};

export function buildBackupDiagnosis(input: {
  /** Live capability: can anything be captured for this app? */
  backupable: boolean;
  capabilityReason: BackupCapabilityReason;
  /** Staging copies are restored from production, so they need no schedule. */
  isStagingResource?: boolean;
  /** Coolify reports active database backup schedules. */
  isConfigured: boolean;
  /** Whether any backup has ever succeeded. */
  hasSuccessfulBackup: boolean;
}): BackupDiagnosis {
  const staging = Boolean(input.isStagingResource);

  if (staging) {
    return {
      applicable: false,
      showNotConfiguredAlarm: false,
      notApplicableDetail:
        "This is a staging copy. It is restored from its production app's backup, so it does not need its own schedule.",
      configuredTone: "unknown",
      configuredDetail: "Not applicable to staging copies.",
      successTone: "unknown"
    };
  }

  // Undetermined (Coolify unreachable or rate limiting) is NOT "nothing to back
  // up". Keep the normal checks so nothing is hidden or declared safe on a gap
  // in information.
  if (!input.backupable && input.capabilityReason === "unknown") {
    return {
      applicable: true,
      showNotConfiguredAlarm: false,
      notApplicableDetail: "",
      configuredTone: "unknown",
      configuredDetail: "Could not reach the platform to check this app's backup configuration.",
      successTone: input.hasSuccessfulBackup ? "healthy" : "unknown"
    };
  }

  if (!input.backupable) {
    const external = input.capabilityReason === "external_database";
    return {
      applicable: false,
      showNotConfiguredAlarm: false,
      notApplicableDetail: external
        ? "This app's data lives in an external database Jongo does not host, so there is no schedule for us to configure."
        : "This app has no database or persistent files, so there is nothing to schedule.",
      configuredTone: "unknown",
      configuredDetail: external
        ? "Not applicable — the database is external."
        : "Not applicable — this app stores no data.",
      // Never "error": there is no successful backup because there is nothing
      // to back up, which is not a fault.
      successTone: "unknown"
    };
  }

  // From here the app genuinely holds data, so the usual checks apply.
  return {
    applicable: true,
    showNotConfiguredAlarm: !input.isConfigured,
    notApplicableDetail: "",
    configuredTone: input.isConfigured ? "healthy" : "error",
    configuredDetail: input.isConfigured
      ? "Automated schedules are configured."
      : "No active backup schedules are configured.",
    successTone: input.hasSuccessfulBackup ? "healthy" : "error"
  };
}
