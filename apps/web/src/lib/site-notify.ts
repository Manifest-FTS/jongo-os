/**
 * Site lifecycle notifications for an app's team.
 *
 * Every backup event emails everyone attached to the app: the owning
 * organisation's owner, its admins, and the app's own collaborators — "admin
 * and contributor" in the language the request used, which maps onto the two
 * roles this codebase actually has (`admin` and `collaborator`).
 *
 * What is mailed is deliberately narrow: the things a human decides to do
 * (creating staging, syncing it either way) and the one thing that silently
 * costs you a restore point (a failed backup). Routine successful backups are
 * NOT mailed. On 51 apps a nightly "backup completed" is ~1,500 mails a month
 * that teach people to filter the sender, at which point the failure alert —
 * the only one that matters — is filtered with it.
 *
 * Failures are rate limited to one per site per 24h. A broken site fails every
 * night, and the second identical email adds nothing the first did not say.
 *
 * The pure parts — who gets mail, and what it says — are separated from sending
 * so they can be tested without a database or a mail provider.
 */

import {
  renderTransactionalEmail,
  type EmailDetailRow,
  type EmailTone
} from "./email-layout";

export type SiteEvent =
  | "backup_started"
  | "backup_succeeded"
  | "backup_failed"
  | "schedule_enabled"
  | "schedule_disabled"
  | "staging_created"
  | "staging_synced_to_production";

/** @deprecated Kept so existing imports keep compiling; use SiteEvent. */
export type BackupEvent = SiteEvent;

/**
 * Which events are mailed. Flip an entry rather than editing a call site, so
 * muting an event stays visible in one place instead of becoming a silent gap.
 *
 * Routine backup traffic is off: a nightly success mail per app is the fastest
 * way to get the whole sender filtered. schedule_enabled/disabled are off too —
 * they are a settings change the person making it can already see.
 */
export const EVENT_DEFAULTS: Record<SiteEvent, boolean> = {
  backup_started: false,
  backup_succeeded: false,
  backup_failed: true,
  schedule_enabled: false,
  schedule_disabled: false,
  staging_created: true,
  staging_synced_to_production: true
};

export function isBackupEventNotified(event: SiteEvent): boolean {
  return EVENT_DEFAULTS[event] === true;
}

export const BACKUP_FAILURE_COOLDOWN_HOURS = 24;

/**
 * Whether a failed backup is worth a second email.
 *
 * "One email if a backup failed" means one, not one per night for a site that
 * has been broken for a week. The first failure after a healthy run always gets
 * through; repeats inside the window do not.
 */
export function shouldNotifyBackupFailure(input: {
  lastAlertAt?: Date | string | null;
  now?: Date;
  cooldownHours?: number;
}): { notify: boolean; reason: "first_failure" | "cooldown_elapsed" | "within_cooldown" } {
  const raw = input.lastAlertAt ? new Date(input.lastAlertAt) : null;
  const lastAlertAt = raw && !Number.isNaN(raw.getTime()) ? raw : null;
  if (!lastAlertAt) return { notify: true, reason: "first_failure" };

  const now = input.now ?? new Date();
  const cooldownMs = (input.cooldownHours ?? BACKUP_FAILURE_COOLDOWN_HOURS) * 60 * 60 * 1000;
  return now.getTime() - lastAlertAt.getTime() < cooldownMs
    ? { notify: false, reason: "within_cooldown" }
    : { notify: true, reason: "cooldown_elapsed" };
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
  /** Staging events: the staging site's own address. */
  stagingUrl?: string | null;
  /** Staging events: the production address it mirrors or was promoted to. */
  productionUrl?: string | null;
  /** staging_created: whether production content was copied in. */
  contentSynced?: boolean | null;
  /** staging_synced_to_production: rows the URL rewrite changed. */
  urlRowsRewritten?: number | null;
  /** staging_synced_to_production: the Coolify deployment it triggered. */
  deploymentId?: string | null;
  /** Who performed it, when a person did. */
  actorEmail?: string | null;
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
 * One event, described once, rendered twice.
 *
 * The subject, the detail rows and the callout are built as data and then handed
 * to the HTML shell and flattened for the text part. Writing the two bodies
 * separately is how they drift, and the text part is the one nobody looks at
 * until a client refuses to render HTML.
 */
type EventCopy = {
  subject: string;
  preheader: string;
  badge: { tone: EmailTone; label: string };
  title: string;
  intro: string;
  rows: EmailDetailRow[];
  callout?: { tone: EmailTone; title?: string; body: string };
  footnote: string;
};

function buildEventCopy(input: BackupEventEmailInput): EventCopy {
  const when = formatUtc(input.at);
  const rawLast = input.lastSuccessAt ? new Date(input.lastSuccessAt) : null;
  const lastSuccess = rawLast && !Number.isNaN(rawLast.getTime()) ? rawLast : null;
  const footnote = `You are receiving this because you have access to ${input.siteName} in Jongo.`;

  switch (input.event) {
    case "backup_started":
      return {
        subject: `Backup started for ${input.siteName}`,
        preheader: `A ${describeTrigger(input.trigger)} is running. No action needed.`,
        badge: { tone: "info", label: "Backup started" },
        title: `Backup started for ${input.siteName}`,
        intro: `A ${describeTrigger(input.trigger)} has started. You will get another email when it finishes — no action is needed.`,
        rows: [
          { label: "App", value: input.siteName },
          { label: "Started", value: when },
          { label: "Type", value: describeTrigger(input.trigger) }
        ],
        footnote
      };

    case "backup_succeeded": {
      const size = formatSize(input.sizeBytes);
      return {
        subject: `Backup completed for ${input.siteName}`,
        preheader: `Completed ${when}${size ? ` · ${size}` : ""}. A new restore point is available.`,
        badge: { tone: "success", label: "Backup completed" },
        title: `Backup completed for ${input.siteName}`,
        intro: "Files and database were captured and stored offsite. This is a restore point you can roll back to.",
        rows: [
          { label: "App", value: input.siteName },
          { label: "Completed", value: when },
          { label: "Size", value: size ?? "Not reported" },
          { label: "Type", value: describeTrigger(input.trigger) }
        ],
        footnote
      };
    }

    case "backup_failed":
      return {
        subject: `Backup failed for ${input.siteName}`,
        preheader: lastSuccess
          ? `Failed ${when}. You can still restore from ${formatUtc(lastSuccess)}.`
          : `Failed ${when}. This app currently has no restore point.`,
        badge: { tone: "danger", label: "Backup failed" },
        title: `Backup failed for ${input.siteName}`,
        intro: `The ${describeTrigger(input.trigger)} did not complete.`,
        rows: [
          { label: "App", value: input.siteName },
          { label: "Failed", value: when },
          { label: "Reason", value: input.error?.trim() || "Not reported" },
          { label: "Type", value: describeTrigger(input.trigger) }
        ],
        callout: lastSuccess
          ? {
              tone: "warning",
              title: "You can still restore",
              body: `The most recent successful backup was ${formatUtc(lastSuccess)}. Automatic backups retry on the next scheduled run; if this keeps failing, take one by hand to see the full error.`
            }
          : {
              tone: "danger",
              title: "No restore point",
              body: "There is no earlier successful backup for this app, so nothing can be restored right now. Take a backup by hand to see the full error."
            },
        footnote
      };

    case "schedule_enabled":
      return {
        subject: `Automatic backups turned on for ${input.siteName}`,
        preheader: `${input.frequencyLabel ?? "Daily"} automatic backups are now on.`,
        badge: { tone: "success", label: "Schedule on" },
        title: `Automatic backups are on for ${input.siteName}`,
        intro: "This app will now be backed up on a schedule, and each run will be reported here.",
        rows: [
          { label: "App", value: input.siteName },
          { label: "Frequency", value: input.frequencyLabel ?? "Daily" },
          { label: "Changed", value: when }
        ],
        footnote
      };

    case "staging_created":
      return {
        subject: `Staging site created for ${input.siteName}`,
        preheader: input.stagingUrl
          ? `Staging is live at ${input.stagingUrl}.`
          : "A staging copy of this site is now available.",
        badge: { tone: "success", label: "Staging created" },
        title: `Staging site created for ${input.siteName}`,
        intro: input.contentSynced === false
          ? "A staging environment was created, but production content has not been copied into it yet — it is still a fresh WordPress install."
          : "A staging copy of this site was created and production content was copied into it. Changes made there do not affect the live site until you promote them.",
        rows: [
          { label: "App", value: input.siteName },
          ...(input.stagingUrl ? [{ label: "Staging URL", value: input.stagingUrl }] : []),
          ...(input.productionUrl ? [{ label: "Production URL", value: input.productionUrl }] : []),
          { label: "Content copied from production", value: input.contentSynced === false ? "Not yet" : "Yes" },
          { label: "Created", value: when },
          ...(input.actorEmail ? [{ label: "By", value: input.actorEmail }] : [])
        ],
        ...(input.contentSynced === false
          ? {
              callout: {
                tone: "warning" as const,
                title: "Content not synced yet",
                body: "Run a production-to-staging content sync before testing, or staging will not reflect the live site."
              }
            }
          : {}),
        footnote
      };

    case "staging_synced_to_production":
      return {
        subject: `Staging promoted to production for ${input.siteName}`,
        preheader: "Staging content is now live in production.",
        badge: { tone: "warning", label: "Promoted to production" },
        title: `Staging promoted to production for ${input.siteName}`,
        intro: "Staging files and database were copied into production and a production deployment was triggered. The live site now serves what staging had.",
        rows: [
          { label: "App", value: input.siteName },
          ...(input.productionUrl ? [{ label: "Production URL", value: input.productionUrl }] : []),
          ...(input.stagingUrl ? [{ label: "Promoted from", value: input.stagingUrl }] : []),
          ...(typeof input.urlRowsRewritten === "number"
            ? [{ label: "URLs rewritten", value: `${input.urlRowsRewritten} row${input.urlRowsRewritten === 1 ? "" : "s"}` }]
            : []),
          ...(input.deploymentId ? [{ label: "Deployment", value: input.deploymentId }] : []),
          { label: "Promoted", value: when },
          ...(input.actorEmail ? [{ label: "By", value: input.actorEmail }] : [])
        ],
        callout: {
          tone: "info",
          title: "This changed the live site",
          body: "A backup was taken before the promotion. If something looks wrong, restore from the Backups tab."
        },
        footnote
      };

    case "schedule_disabled":
      return {
        subject: `Automatic backups turned off for ${input.siteName}`,
        preheader: "No new restore points will be created until they are turned back on.",
        badge: { tone: "warning", label: "Schedule off" },
        title: `Automatic backups are off for ${input.siteName}`,
        intro: "You can still take a backup at any time from the Backups tab.",
        rows: [
          { label: "App", value: input.siteName },
          { label: "Changed", value: when },
          { label: "Most recent backup", value: lastSuccess ? formatUtc(lastSuccess) : "None yet" }
        ],
        callout: {
          tone: "warning",
          title: "No new restore points",
          body: "Nothing will be backed up automatically until the schedule is turned back on."
        },
        footnote
      };
  }
}

/**
 * The email body, in both parts. Plain and specific: what happened, when, and
 * the one thing the reader might need to do about it.
 */
export function buildBackupEventEmail(
  input: BackupEventEmailInput
): { subject: string; text: string; html: string } {
  const copy = buildEventCopy(input);

  const text = [
    copy.title,
    "",
    copy.intro,
    "",
    ...copy.rows.map((row) => `${row.label}: ${row.value}`),
    ...(copy.callout ? ["", copy.callout.title ? `${copy.callout.title}: ${copy.callout.body}` : copy.callout.body] : []),
    "",
    `Open backups: ${input.siteUrl}`,
    "",
    copy.footnote
  ].join("\n");

  const html = renderTransactionalEmail({
    preheader: copy.preheader,
    badge: copy.badge,
    title: copy.title,
    intro: copy.intro,
    rows: copy.rows,
    callout: copy.callout,
    cta: { label: "View backups", url: input.siteUrl },
    footnote: copy.footnote
  });

  return { subject: copy.subject, text, html };
}

export type NotifyResult = {
  attempted: number;
  sent: number;
  skippedReason?: "event_muted" | "no_recipients" | "site_missing" | "within_cooldown";
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
  event: SiteEvent;
  at?: Date;
  error?: string | null;
  trigger?: string | null;
  sizeBytes?: number | null;
  frequencyLabel?: string | null;
  stagingUrl?: string | null;
  productionUrl?: string | null;
  contentSynced?: boolean | null;
  urlRowsRewritten?: number | null;
  deploymentId?: string | null;
  actorEmail?: string | null;
}): Promise<NotifyResult> {
  if (!isBackupEventNotified(input.event)) {
    return { attempted: 0, sent: 0, skippedReason: "event_muted" };
  }

  // siteId must be a real Site.id. Several callers hand around a SLUG or a
  // Coolify uuid under the same name, and Prisma answers a non-uuid value on a
  // @db.Uuid column with "Inconsistent column data: Error creating UUID" — a
  // thrown query and a logged error, once per attempt. Refuse it here instead.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.siteId ?? "")) {
    console.warn(`[jongo] notifyBackupEvent(${input.event}): ignoring non-uuid siteId "${input.siteId}"`);
    return { attempted: 0, sent: 0, skippedReason: "site_missing" };
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
        backupAlertSentAt: true,
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

    // "One email if a backup failed" — not one per night for a site that has
    // been failing all week. Checked before recipients are resolved so a
    // suppressed alert costs nothing.
    if (input.event === "backup_failed") {
      const decision = shouldNotifyBackupFailure({ lastAlertAt: site.backupAlertSentAt, now: input.at });
      if (!decision.notify) {
        return { attempted: 0, sent: 0, skippedReason: "within_cooldown" };
      }
    }

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
      frequencyLabel: input.frequencyLabel,
      stagingUrl: input.stagingUrl,
      productionUrl: input.productionUrl,
      contentSynced: input.contentSynced,
      urlRowsRewritten: input.urlRowsRewritten,
      deploymentId: input.deploymentId,
      actorEmail: input.actorEmail
    });

    const { sendTransactionalEmail } = await import("@/lib/email");
    let sent = 0;
    for (const to of recipients) {
      try {
        const result = await sendTransactionalEmail({
          to,
          subject: message.subject,
          text: message.text,
          html: message.html
        });
        if (result.sent) sent += 1;
      } catch {
        // Next recipient — one bad address must not silence the rest.
      }
    }

    // Stamped only on a send that actually happened, so a misconfigured mailer
    // cannot silently burn the next 24 hours of failure alerts.
    if (input.event === "backup_failed" && sent > 0) {
      try {
        await (db as any).site.update({
          where: { id: site.id },
          data: { backupAlertSentAt: input.at ?? new Date() }
        });
      } catch {
        // Worst case the next failure emails again — far better than losing it.
      }
    }

    return { attempted: recipients.length, sent };
  } catch (error) {
    console.error(`notifyBackupEvent(${input.event}) failed for site ${input.siteId}:`, error);
    return { attempted: 0, sent: 0 };
  }
}
