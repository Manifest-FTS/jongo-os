/**
 * Backup lifecycle notifications for an app's team.
 *
 * Every backup event emails everyone attached to the app: the owning
 * organisation's owner, its admins, and the app's own collaborators — "admin
 * and contributor" in the language the request used, which maps onto the two
 * roles this codebase actually has (`admin` and `collaborator`).
 *
 * This deliberately has NO cooldown. The previous rule emailed only failures,
 * only the owner, and at most once per site per 24h, on the reasoning that a
 * nightly email trains people to filter alerts. That was traded away on purpose:
 * the ask was every event to everyone. Volume is therefore bounded only by the
 * schedule — on a 24h schedule expect roughly two mails per site per day
 * (started + finished) per recipient. If that turns out to be too much, the
 * lever is EVENT_DEFAULTS below, not a silent suppression that makes some
 * events vanish without explanation.
 *
 * The pure parts — who gets mail, and what it says — are separated from sending
 * so they can be tested without a database or a mail provider.
 */

export type BackupEvent =
  | "backup_started"
  | "backup_succeeded"
  | "backup_failed"
  | "schedule_enabled"
  | "schedule_disabled";

/**
 * Which events are mailed. All on, per the request. Flip an entry to false to
 * mute one class of event without touching call sites.
 */
export const EVENT_DEFAULTS: Record<BackupEvent, boolean> = {
  backup_started: true,
  backup_succeeded: true,
  backup_failed: true,
  schedule_enabled: true,
  schedule_disabled: true
};

export function isBackupEventNotified(event: BackupEvent): boolean {
  return EVENT_DEFAULTS[event] === true;
}

/** A very forgiving check: enough to avoid handing the provider obvious junk. */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * The people to notify for one app, deduplicated case-insensitively.
 *
 * The set mirrors who is allowed to act on the app in the first place — the
 * same owner / org-collaborator / app-collaborator union the promote and site
 * routes authorize against. Both roles are included deliberately: the request
 * asked for admins AND contributors, and narrowing to admins would silence the
 * people most likely to be doing the work.
 *
 * Order is stable — owner, then org collaborators, then app collaborators — so
 * tests and logs read predictably. Soft-deleted rows must be filtered by the
 * caller's query; this function only sees what it is given.
 */
export function collectSiteRecipients(input: {
  ownerEmail?: string | null;
  organizationCollaboratorEmails?: Array<string | null | undefined>;
  collaboratorEmails?: Array<string | null | undefined>;
}): string[] {
  const ordered = [
    input.ownerEmail,
    ...(input.organizationCollaboratorEmails ?? []),
    ...(input.collaboratorEmails ?? [])
  ];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ordered) {
    const email = (raw ?? "").trim();
    if (!email || !looksLikeEmail(email)) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

export type BackupEventEmailInput = {
  event: BackupEvent;
  siteName: string;
  /** Link to the app's Backups tab. */
  siteUrl: string;
  at: Date;
  /** Failure detail, when the provider reported one. */
  error?: string | null;
  /** So a failure mail can say what is still restorable. */
  lastSuccessAt?: Date | string | null;
  /** Set on schedule_enabled — e.g. "Daily". */
  frequencyLabel?: string | null;
  /** What kicked the backup off: manual, scheduled, or promote. */
  trigger?: string | null;
  sizeBytes?: number | null;
};

function formatUtc(value: Date): string {
  return `${value.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function formatSize(bytes?: number | null): string | null {
  if (!bytes || bytes <= 0) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function describeTrigger(trigger?: string | null): string {
  switch ((trigger ?? "").trim()) {
    case "scheduled":
      return "automatic scheduled backup";
    case "promote":
      return "backup taken before a promotion to production";
    case "manual":
      return "backup started by hand";
    default:
      return "backup";
  }
}

/**
 * The email body. Plain and specific: what happened, when, and the one thing
 * the reader might need to do about it.
 */
export function buildBackupEventEmail(input: BackupEventEmailInput): { subject: string; text: string } {
  const when = formatUtc(input.at);
  const rawLast = input.lastSuccessAt ? new Date(input.lastSuccessAt) : null;
  const lastSuccess = rawLast && !Number.isNaN(rawLast.getTime()) ? rawLast : null;

  const footer = ["", `Open backups: ${input.siteUrl}`];

  switch (input.event) {
    case "backup_started":
      return {
        subject: `Backup started for ${input.siteName}`,
        text: [
          `A ${describeTrigger(input.trigger)} has started for ${input.siteName}.`,
          "",
          `Started at: ${when}`,
          "You will get another email when it finishes. No action is needed.",
          ...footer
        ].join("\n")
      };

    case "backup_succeeded": {
      const size = formatSize(input.sizeBytes);
      return {
        subject: `Backup completed for ${input.siteName}`,
        text: [
          `The ${describeTrigger(input.trigger)} for ${input.siteName} completed successfully.`,
          "",
          `Completed at: ${when}`,
          size ? `Size: ${size}` : "Size: not reported.",
          "Files and database are stored offsite. This is a restore point you can roll back to.",
          ...footer
        ].join("\n")
      };
    }

    case "backup_failed":
      return {
        subject: `Backup failed for ${input.siteName}`,
        text: [
          `The ${describeTrigger(input.trigger)} for ${input.siteName} did not complete.`,
          "",
          `Failed at: ${when}`,
          input.error ? `Reason: ${input.error}` : "Reason: not reported.",
          lastSuccess
            ? `Last successful backup: ${formatUtc(lastSuccess)} — you can still restore from that one.`
            : "There is no earlier successful backup for this app, so it currently has no restore point.",
          "",
          "Automatic backups will be retried on the next scheduled run. If this keeps failing, take a backup manually from that page to see the error in full.",
          ...footer
        ].join("\n")
      };

    case "schedule_enabled":
      return {
        subject: `Automatic backups turned on for ${input.siteName}`,
        text: [
          `Automatic backups are now on for ${input.siteName}.`,
          "",
          `Frequency: ${input.frequencyLabel ?? "Daily"}`,
          `Changed at: ${when}`,
          ...footer
        ].join("\n")
      };

    case "schedule_disabled":
      return {
        subject: `Automatic backups turned off for ${input.siteName}`,
        text: [
          `Automatic backups have been turned off for ${input.siteName}.`,
          "",
          `Changed at: ${when}`,
          "No new restore points will be created until they are turned back on. You can still take a backup at any time.",
          lastSuccess
            ? `Most recent backup: ${formatUtc(lastSuccess)}.`
            : "This app has no successful backup yet.",
          ...footer
        ].join("\n")
      };
  }
}

export type NotifyResult = {
  attempted: number;
  sent: number;
  skippedReason?: "event_muted" | "no_recipients" | "site_missing";
};

/**
 * Look up the app's team and mail them about one event.
 *
 * Never throws: a notification failing must not fail the backup, the promote,
 * or the ops callback that reported the outcome. Failures are logged and
 * counted instead.
 */
export async function notifyBackupEvent(input: {
  siteId: string;
  event: BackupEvent;
  at?: Date;
  error?: string | null;
  trigger?: string | null;
  sizeBytes?: number | null;
  frequencyLabel?: string | null;
}): Promise<NotifyResult> {
  if (!isBackupEventNotified(input.event)) {
    return { attempted: 0, sent: 0, skippedReason: "event_muted" };
  }

  try {
    const { getDb } = await import("@/lib/db");
    const db = await getDb();
    if (!db) return { attempted: 0, sent: 0, skippedReason: "site_missing" };

    const site = await (db as any).site.findUnique({
      where: { id: input.siteId },
      select: {
        id: true,
        slug: true,
        name: true,
        organization: {
          select: {
            owner: { select: { email: true } },
            collaborators: {
              where: { deletedAt: null },
              select: { user: { select: { email: true } } }
            }
          }
        },
        collaborators: {
          where: { deletedAt: null },
          select: { user: { select: { email: true } } }
        }
      }
    });
    if (!site) return { attempted: 0, sent: 0, skippedReason: "site_missing" };

    const recipients = collectSiteRecipients({
      ownerEmail: site.organization?.owner?.email,
      organizationCollaboratorEmails: (site.organization?.collaborators ?? []).map((c: any) => c?.user?.email),
      collaboratorEmails: (site.collaborators ?? []).map((c: any) => c?.user?.email)
    });
    if (recipients.length === 0) {
      return { attempted: 0, sent: 0, skippedReason: "no_recipients" };
    }

    // Only needed for the two events that reference it, so it is not fetched
    // for every started/succeeded mail.
    let lastSuccessAt: Date | null = null;
    if (input.event === "backup_failed" || input.event === "schedule_disabled") {
      const last = await (db as any).siteBackup.findFirst({
        where: { siteId: site.id, status: "success" },
        orderBy: { completedAt: "desc" },
        select: { completedAt: true }
      });
      lastSuccessAt = last?.completedAt ?? null;
    }

    const base = (process.env.NEXTAUTH_URL || process.env.APP_BASE_URL || "").replace(/\/+$/, "");
    const message = buildBackupEventEmail({
      event: input.event,
      siteName: site.name || site.slug,
      siteUrl: `${base}/apps/${encodeURIComponent(site.slug)}/backups`,
      at: input.at ?? new Date(),
      error: input.error,
      lastSuccessAt,
      trigger: input.trigger,
      sizeBytes: input.sizeBytes,
      frequencyLabel: input.frequencyLabel
    });

    const { sendTransactionalEmail } = await import("@/lib/email");
    let sent = 0;
    for (const to of recipients) {
      try {
        const result = await sendTransactionalEmail({ to, subject: message.subject, text: message.text });
        if (result.sent) sent += 1;
      } catch {
        // Next recipient — one bad address must not silence the rest.
      }
    }

    return { attempted: recipients.length, sent };
  } catch (error) {
    console.error(`notifyBackupEvent(${input.event}) failed for site ${input.siteId}:`, error);
    return { attempted: 0, sent: 0 };
  }
}
