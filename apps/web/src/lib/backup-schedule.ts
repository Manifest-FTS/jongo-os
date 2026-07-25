/**
 * Per-site backup schedule: the customer-facing half of the hourly scheduler.
 *
 * Import-free so the validation and the "when does this next run?" arithmetic
 * can be tested directly — both are things a customer reads off the screen and
 * will hold us to.
 */

/** Frequencies we offer. Anything else is rejected rather than silently coerced. */
export const BACKUP_FREQUENCY_CHOICES = [
  { hours: 6, label: "Every 6 hours" },
  { hours: 12, label: "Every 12 hours" },
  { hours: 24, label: "Daily" },
  { hours: 168, label: "Weekly" }
] as const;

export function isValidBackupFrequency(hours: unknown): boolean {
  return BACKUP_FREQUENCY_CHOICES.some((c) => c.hours === hours);
}

export function describeBackupFrequency(hours: number | null | undefined): string {
  const match = BACKUP_FREQUENCY_CHOICES.find((c) => c.hours === hours);
  if (match) return match.label;
  if (!hours || hours <= 0) return "Daily";
  return `Every ${hours} hours`;
}

export type ScheduleSummary = {
  /** Resolved on/off, after applying the platform default to a null setting. */
  enabled: boolean;
  /** True when this site follows the platform default rather than its own choice. */
  inheritsDefault: boolean;
  frequencyHours: number;
  frequencyLabel: string;
  lastRunAt: string | null;
  /** Null when the schedule is off, or when no run has happened yet. */
  nextRunAt: string | null;
  /** One line for the UI, phrased for a non-technical owner. */
  detail: string;
};

export function summarizeBackupSchedule(input: {
  backupScheduleEnabled: boolean | null | undefined;
  backupFrequencyHours: number | null | undefined;
  lastScheduledBackupAt: Date | string | null | undefined;
  platformDefaultEnabled?: boolean;
  now?: Date;
}): ScheduleSummary {
  const inheritsDefault = input.backupScheduleEnabled === null || input.backupScheduleEnabled === undefined;
  const enabled = inheritsDefault ? Boolean(input.platformDefaultEnabled) : Boolean(input.backupScheduleEnabled);
  const frequencyHours =
    input.backupFrequencyHours && input.backupFrequencyHours > 0 ? input.backupFrequencyHours : 24;
  const frequencyLabel = describeBackupFrequency(frequencyHours);

  const lastRun = input.lastScheduledBackupAt ? new Date(input.lastScheduledBackupAt) : null;
  const lastValid = lastRun && !Number.isNaN(lastRun.getTime()) ? lastRun : null;

  if (!enabled) {
    return {
      enabled: false,
      inheritsDefault,
      frequencyHours,
      frequencyLabel,
      lastRunAt: lastValid ? lastValid.toISOString() : null,
      nextRunAt: null,
      detail: "Automatic backups are off. You can still take a backup at any time."
    };
  }

  // The scheduler runs hourly, so a due backup starts within the hour rather
  // than exactly on the boundary. Saying "due now" is honest; naming a precise
  // past minute would not be.
  const now = input.now ?? new Date();
  const next = lastValid ? new Date(lastValid.getTime() + frequencyHours * 60 * 60 * 1000) : null;
  const detail = !next
    ? `${frequencyLabel} — the first automatic backup runs within the hour.`
    : next.getTime() <= now.getTime()
      ? `${frequencyLabel} — the next backup is due now and starts within the hour.`
      : `${frequencyLabel} — next backup ${next.toISOString().slice(0, 16).replace("T", " ")} UTC.`;

  return {
    enabled: true,
    inheritsDefault,
    frequencyHours,
    frequencyLabel,
    lastRunAt: lastValid ? lastValid.toISOString() : null,
    nextRunAt: next ? next.toISOString() : null,
    detail
  };
}
