/**
 * Deciding when a failed backup is worth emailing about.
 *
 * The gap this closes is specifically SCHEDULED backups: an on-demand backup
 * already reports failure as a toast to the person who started it and is
 * watching, whereas a scheduled one fails at 3am into a log nobody reads. A
 * customer who believes they are protected and is not is the worst outcome this
 * feature can produce, so scheduled failures must reach a human.
 *
 * The counterweight is spam. A site that is broken fails every night, and a
 * nightly email trains people to filter the alerts — at which point the alert
 * is worth less than nothing. So alerts are rate limited per site, and the
 * first failure after a healthy run always gets through.
 *
 * Import-free so it can be tested without a database.
 */

export const BACKUP_ALERT_COOLDOWN_HOURS = 24;

export type AlertDecision = { alert: boolean; reason: string };

export function shouldAlertOnBackupFailure(input: {
  status: string;
  trigger: string;
  /** When we last emailed about a failure for this site. */
  lastAlertAt?: Date | string | null;
  now?: Date;
  cooldownHours?: number;
}): AlertDecision {
  if (input.status !== "failed") {
    return { alert: false, reason: "not_a_failure" };
  }
  if (input.trigger !== "scheduled") {
    // The person who pressed the button is watching the page and already got
    // an error toast; emailing them as well is noise.
    return { alert: false, reason: "on_demand_failure_is_already_visible" };
  }

  const raw = input.lastAlertAt ? new Date(input.lastAlertAt) : null;
  const lastAlertAt = raw && !Number.isNaN(raw.getTime()) ? raw : null;
  if (!lastAlertAt) {
    return { alert: true, reason: "first_failure" };
  }

  const now = input.now ?? new Date();
  const cooldownMs = (input.cooldownHours ?? BACKUP_ALERT_COOLDOWN_HOURS) * 60 * 60 * 1000;
  if (now.getTime() - lastAlertAt.getTime() < cooldownMs) {
    return { alert: false, reason: "within_cooldown" };
  }
  return { alert: true, reason: "cooldown_elapsed" };
}

/**
 * The email body. Plain and specific: what failed, when, why if we know, and
 * the one thing the reader should do about it.
 */
export function buildBackupFailureEmail(input: {
  siteName: string;
  siteUrl: string;
  failedAt: Date;
  error?: string | null;
  lastSuccessAt?: Date | string | null;
}): { subject: string; text: string } {
  const when = input.failedAt.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const rawLast = input.lastSuccessAt ? new Date(input.lastSuccessAt) : null;
  const lastSuccess = rawLast && !Number.isNaN(rawLast.getTime()) ? rawLast : null;

  const text = [
    `The scheduled backup for ${input.siteName} did not complete.`,
    "",
    `Failed at: ${when}`,
    input.error ? `Reason: ${input.error}` : "Reason: not reported.",
    lastSuccess
      ? `Last successful backup: ${lastSuccess.toISOString().slice(0, 16).replace("T", " ")} UTC — you can still restore from that one.`
      : "There is no earlier successful backup for this app, so it currently has no restore point.",
    "",
    `Open backups: ${input.siteUrl}`,
    "",
    "Automatic backups will be retried on the next scheduled run. If this keeps failing, take a backup manually from that page to see the error in full."
  ].join("\n");

  return {
    subject: `Backup failed for ${input.siteName}`,
    text
  };
}
