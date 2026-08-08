/**
 * Slack notifications for backup events.
 *
 * Backups only ever emailed the organisation owner. A SlackProvider existed but
 * was wired solely to security scanning, and there was no UI to register a
 * webhook — so the plumbing was real and had no tap.
 *
 * What is notify-worthy is not just "a backup failed". Three events matter, and
 * two of them were previously silent:
 *
 *   - a scheduled backup FAILED — the owner believes they are protected;
 *   - a backup SUCCEEDED while capturing nothing (the empty-database case) —
 *     the most dangerous state, because every signal says healthy;
 *   - a REHEARSAL failed — the backup exists and would not restore.
 *
 * Manual backup failures are deliberately excluded: whoever pressed the button
 * already saw a toast, and paging a channel about it trains people to mute it.
 */

export type BackupSlackEvent =
  | { kind: "backup_failed"; siteName: string; siteUrl?: string; error?: string | null; lastSuccessAt?: Date | string | null }
  | { kind: "backup_empty"; siteName: string; siteUrl?: string; detail?: string | null }
  | { kind: "rehearsal_failed"; siteName: string; siteUrl?: string; reason?: string | null; detail?: string | null };

export type SlackMessage = {
  /** Slack attachment colour. */
  color: string;
  title: string;
  text: string;
  fields: Array<{ title: string; value: string; short: boolean }>;
};

const RED = "#d7263d";
const AMBER = "#f5a623";

export function buildBackupSlackMessage(event: BackupSlackEvent): SlackMessage {
  if (event.kind === "backup_failed") {
    return {
      color: RED,
      title: `Backup failed — ${event.siteName}`,
      text:
        "A scheduled backup did not complete. This site may have no recent restore point.",
      fields: compact([
        field("Error", event.error),
        field("Last successful backup", formatWhen(event.lastSuccessAt) ?? "never"),
        field("App", event.siteUrl)
      ])
    };
  }

  if (event.kind === "backup_empty") {
    return {
      // Amber, not red: nothing is broken. The backup ran correctly and found
      // nothing, which is either a brand new app or a serious misconfiguration
      // — and only a human can tell which.
      color: AMBER,
      title: `Backup captured nothing — ${event.siteName}`,
      text:
        "The backup completed successfully but contains no data. If this app should hold data, its restore point is empty.",
      fields: compact([field("Detail", event.detail), field("App", event.siteUrl)])
    };
  }

  return {
    color: RED,
    title: `Backup is not restorable — ${event.siteName}`,
    text:
      "A rehearsal restored this backup into a throwaway container and it did not come back. The backup exists but would not restore.",
    fields: compact([
      field("Reason", event.reason),
      field("Detail", event.detail),
      field("App", event.siteUrl)
    ])
  };
}

/**
 * Where to send. A platform-wide webhook needs no UI, which matters because
 * there is none — without this the feature would ship unreachable.
 */
export function resolveSlackWebhooks(input: {
  platformWebhook?: string | null;
  orgWebhooks?: Array<string | null | undefined>;
}): string[] {
  const all = [input.platformWebhook, ...(input.orgWebhooks ?? [])];
  const out: string[] = [];
  for (const raw of all) {
    const url = String(raw ?? "").trim();
    // Only real Slack webhooks. A misconfigured value must not cause backup
    // outcomes to be POSTed to an arbitrary host.
    if (!/^https:\/\/hooks\.slack\.com\//i.test(url)) continue;
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

function field(title: string, value: string | null | undefined) {
  const v = String(value ?? "").trim();
  return v ? { title, value: v, short: v.length < 40 } : null;
}

function compact<T>(items: Array<T | null>): T[] {
  return items.filter((i): i is T => i !== null);
}

function formatWhen(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString().replace("T", " ").slice(0, 16) + " UTC" : null;
}
