/**
 * What the Backups page should offer, given what we know about an app.
 *
 * The page previously probed Coolify live on every render and mapped any
 * failure to "not backupable". Coolify rate limits, so a busy moment produced a
 * Backups section with no way to take a backup and no explanation — the feature
 * visibly present and silently inert.
 *
 * Two rules fix that:
 *
 *   1. Prefer the answer the hourly reconciler cached. It costs no API call,
 *      which also stops the page contributing to the rate limiting that caused
 *      the problem.
 *   2. When the answer is not known, OFFER the action. The create-backup API
 *      re-checks live and returns a precise error if there is genuinely nothing
 *      to capture, which is far better than a missing button. Withholding the
 *      control on incomplete information is what made this confusing.
 *
 * Only a definitive "this app holds nothing" hides the feature.
 */

export type ViewCapabilityReason =
  | "service_containers"
  | "standalone_database"
  | "persistent_volumes"
  | "linked_database"
  | "external_database"
  | "stateless"
  | "unknown";

export type BackupViewCapability = {
  /** Known to hold data we can capture. */
  backupable: boolean;
  reason: ViewCapabilityReason;
  /** Show the backup list, schedule and metrics. */
  showBackupFeatures: boolean;
  /** Allow starting a backup. True when unknown, so the API can arbitrate. */
  allowBackupAction: boolean;
  /** Set when we are offering the action without having verified. */
  unverifiedNote?: string;
};

export function resolveBackupViewCapability(input: {
  /** Cached by the reconciler; null when never evaluated. */
  cachedBackupable?: boolean | null;
  cachedReason?: string | null;
  /** Live probe, used only when there is no cached answer. */
  liveBackupable?: boolean | null;
  liveReason?: string | null;
  isStagingResource?: boolean;
}): BackupViewCapability {
  if (input.isStagingResource) {
    return {
      backupable: false,
      reason: "stateless",
      showBackupFeatures: false,
      allowBackupAction: false
    };
  }

  const cachedUsable =
    typeof input.cachedBackupable === "boolean" &&
    typeof input.cachedReason === "string" &&
    input.cachedReason !== "" &&
    input.cachedReason !== "unknown";

  const backupable = cachedUsable ? Boolean(input.cachedBackupable) : Boolean(input.liveBackupable);
  const reason = (cachedUsable ? input.cachedReason : input.liveReason) as ViewCapabilityReason | undefined;
  const resolved: ViewCapabilityReason = reason ? reason : "unknown";

  if (backupable) {
    return {
      backupable: true,
      reason: resolved,
      showBackupFeatures: true,
      allowBackupAction: true
    };
  }

  // Definitively nothing to capture — the only case that hides the feature.
  if (resolved === "stateless") {
    return {
      backupable: false,
      reason: "stateless",
      showBackupFeatures: false,
      allowBackupAction: false
    };
  }

  // The data exists but not somewhere we can reach. Keep the section, because
  // it is where the owner is told their data is not backed up here, but there
  // is nothing for the button to do.
  if (resolved === "external_database") {
    return {
      backupable: false,
      reason: "external_database",
      showBackupFeatures: false,
      allowBackupAction: false
    };
  }

  return {
    backupable: false,
    reason: "unknown",
    showBackupFeatures: true,
    allowBackupAction: true,
    unverifiedNote:
      "We could not reach the platform to confirm what this app stores, so backup details may be incomplete. You can still start a backup — it will report exactly what it finds."
  };
}
