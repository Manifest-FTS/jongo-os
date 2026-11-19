/**
 * Alerts for platform admins about problems a client can't act on (backups
 * blocked on the server, for example). Sent to the platform Slack webhook
 * (JONGO_SLACK_WEBHOOK_URL) and emailed to platform admins, at most once per
 * key per `everyHours`, so a problem that lasts days is one message, not one
 * per hour.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const ALERT_ACTION = "platform_alert_sent";

export async function sendPlatformAlert(input: {
  key: string;
  /** Any organization the alert concerns; the audit row (the rate limit) lives there. */
  organizationId: string;
  subject: string;
  text: string;
  everyHours?: number;
  db?: any;
}): Promise<{ sent: boolean; skipped?: "recently_sent" | "no_recipients" }> {
  const db = input.db ?? (await import("@/lib/db")).db;
  const since = new Date(Date.now() - (input.everyHours ?? 12) * 3_600_000);
  const recent = await db.auditLog.findFirst({
    where: { action: ALERT_ACTION, createdAt: { gte: since }, details: { path: ["key"], equals: input.key } },
    select: { id: true }
  });
  if (recent) return { sent: false, skipped: "recently_sent" };

  let delivered = 0;
  const webhook = process.env.JONGO_SLACK_WEBHOOK_URL?.trim();
  if (webhook) {
    try {
      const res = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attachments: [{ color: "#d97706", title: input.subject, text: input.text }] })
      });
      if (res.ok) delivered += 1;
    } catch {
      // Email below still goes.
    }
  }

  const emails = new Set<string>();
  const seed = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  if (seed) emails.add(seed);
  try {
    const admins = await db.platformAdmin.findMany({ select: { user: { select: { email: true, deletedAt: true } } } });
    for (const row of admins ?? []) if (row.user?.email && !row.user.deletedAt) emails.add(String(row.user.email).toLowerCase());
  } catch {
    // Seed address alone.
  }
  if (emails.size > 0) {
    const { sendTransactionalEmail } = await import("@/lib/email");
    for (const to of emails) {
      const result = await sendTransactionalEmail({ to, subject: input.subject, text: input.text }).catch(() => ({ sent: false }));
      if (result.sent) delivered += 1;
    }
  }
  if (delivered === 0) return { sent: false, skipped: "no_recipients" };

  await db.auditLog.create({
    data: { organizationId: input.organizationId, action: ALERT_ACTION, resourceType: "platform", details: { key: input.key, subject: input.subject } }
  }).catch(() => null);
  return { sent: true };
}
