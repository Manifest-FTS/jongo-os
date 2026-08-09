import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Callback endpoint for scripts/site-backup.mjs — records the outcome of a
 * backup run (restic snapshot id + content metadata) against its catalog row.
 */
export async function POST(request: Request) {
  const opsToken = process.env.BACKUP_RECONCILE_TOKEN?.trim() || process.env.OWNERSHIP_SYNC_TOKEN?.trim();
  const provided = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!opsToken || !provided || provided !== opsToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const backupId = typeof body.backupId === "string" ? body.backupId.trim() : "";
  const status = typeof body.status === "string" ? body.status.trim() : "";
  if (!backupId) {
    return NextResponse.json({ error: "backupId is required." }, { status: 400 });
  }
  // A deferred run yielded to a deploy or to another backup before doing any
  // work. Nothing was attempted, so the placeholder row is removed rather than
  // recorded: keeping it as "failed" would both litter the catalogue and email
  // the owner an alert about a backup that was simply being polite.
  //
  // The scheduler stamps lastScheduledBackupAt BEFORE spawning the script (so a
  // crashed run cannot cause a retry storm), which means a deferral would
  // otherwise push the site out by a full backupFrequencyHours — a one-minute
  // deploy costing a day of protection. Rewinding it to the last backup that
  // actually succeeded makes the site due again on the next hourly pass, which
  // is the whole point of deferring rather than failing.
  if (status === "deferred") {
    try {
      const { db } = await import("@/lib/db");
      const row = await db.siteBackup.findUnique({
        where: { id: backupId },
        select: { siteId: true, status: true }
      });
      const deleted = await db.siteBackup.deleteMany({ where: { id: backupId, status: "running" } });

      let rewound = false;
      if (row?.siteId && (deleted?.count ?? 0) > 0) {
        const lastSuccess = await db.siteBackup.findFirst({
          where: { siteId: row.siteId, status: "success" },
          orderBy: { completedAt: "desc" },
          select: { completedAt: true }
        });
        await db.site.update({
          where: { id: row.siteId },
          data: { lastScheduledBackupAt: lastSuccess?.completedAt ?? null }
        });
        rewound = true;
      }

      return NextResponse.json({ ok: true, backupId, status, removed: deleted?.count ?? 0, rewound });
    } catch (error) {
      return NextResponse.json(
        { error: `Failed to clear deferred backup: ${error instanceof Error ? error.message : "unknown"}` },
        { status: 500 }
      );
    }
  }

  if (status !== "success" && status !== "failed") {
    return NextResponse.json({ error: "status must be 'success' or 'failed'." }, { status: 400 });
  }

  const int = (value: unknown): number | null => {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  };
  const str = (value: unknown): string | null =>
    typeof value === "string" && value.trim() ? value.trim() : null;

  try {
    const { db } = await import("@/lib/db");
    const sizeBytes = int(body.sizeBytes);

    // Classify the stack here rather than trusting the script's own guess: the
    // rule lives in lib/backup-stack.ts where it is unit tested, and the script
    // deliberately reports only raw findings. Markers are absent when an older
    // script version posts, in which case the script's resourceType stands.
    //
    // The MARKERS are stored, not the rendered metrics. Storing the rendering
    // would freeze each row's presentation at the moment it was taken, so a
    // later fix to a label or a unit would never reach existing backups.
    const markers = body.stackMarkers;
    let content: { stack: string; markers: unknown } | null = null;
    if (markers && typeof markers === "object" && !Array.isArray(markers)) {
      const { detectStack } = await import("@/lib/backup-stack");
      content = { stack: detectStack(markers as Record<string, never>), markers };
    }

    const updated = await db.siteBackup.update({
      where: { id: backupId },
      data: {
        status,
        resticSnapshotId: str(body.resticSnapshotId),
        sizeBytes: sizeBytes === null ? null : BigInt(sizeBytes),
        contentSummary: content ?? undefined,
        resourceType: content?.stack ?? str(body.resourceType),
        volumeCount: int(body.volumeCount),
        databaseCount: int(body.databaseCount),
        databaseTables: int(body.databaseTables),
        posts: int(body.posts),
        pages: int(body.pages),
        plugins: int(body.plugins),
        comments: int(body.comments),
        wpVersion: str(body.wpVersion),
        error: str(body.error),
        completedAt: new Date()
      }
    });

    // Retention removed these snapshots from Backblaze, so their catalogue rows
    // must stop offering a restore that would fail against a missing snapshot.
    let prunedRows = 0;
    const { parseForgottenSnapshotIdsFromBase64 } = await import("@/lib/restic-forget");
    const forgotten = Array.isArray(body.forgottenSnapshotIds)
      ? body.forgottenSnapshotIds.map((v) => String(v).trim()).filter(Boolean)
      // Accept the raw payload too, so the parsing rule has one tested home
      // even if an older script version posts the base64 directly.
      : parseForgottenSnapshotIdsFromBase64(
          typeof body.forgetJsonBase64 === "string" ? body.forgetJsonBase64 : null
        );
    if (forgotten.length > 0) {
      const result = await db.siteBackup.updateMany({
        where: { resticSnapshotId: { in: forgotten }, status: "success" },
        data: { status: "pruned" }
      });
      prunedRows = result?.count ?? 0;
    }

    // Every finished backup emails the app's whole team — owner, org
    // collaborators and app collaborators — on both outcomes. This replaced the
    // former owner-only, scheduled-failures-only, once-per-24h email; keeping
    // both would have double-mailed the owner on every failure.
    let alerted = false;
    let slackSent = 0;
    try {
      // Only the two terminal outcomes are events. Guarding on the exact values
      // rather than treating "not success" as failure keeps a future status
      // (pruned, cancelled) from mailing everyone a false failure.
      if (updated.status === "success" || updated.status === "failed") {
        const { notifyBackupEvent } = await import("@/lib/backup-notify");
        const notified = await notifyBackupEvent({
          siteId: updated.siteId,
          event: updated.status === "success" ? "backup_succeeded" : "backup_failed",
          at: updated.completedAt ? new Date(updated.completedAt) : new Date(),
          error: updated.error,
          trigger: updated.trigger,
          sizeBytes: updated.sizeBytes ? Number(updated.sizeBytes) : null
        });
        alerted = notified.sent > 0;
      }

      // Slack gets the empty-capture case too, which the email path does not
      // cover: a backup that succeeded while capturing nothing is the state
      // most likely to be believed, because every other signal says healthy.
      if (updated.status === "failed" && updated.trigger === "scheduled") {
        slackSent = await notifySlack(db, updated, "backup_failed");
      } else if (updated.status === "success") {
        const { describeBackupContent } = await import("@/lib/backup-content");
        const verdict = describeBackupContent({
          volumeCount: updated.volumeCount,
          databaseCount: updated.databaseCount,
          databaseTables: updated.databaseTables
        });
        if (!verdict.hasContent) {
          slackSent = await notifySlack(db, { ...updated, error: verdict.detail }, "backup_empty");
        }
      }
    } catch {
      // Never let alerting failure mask a successfully recorded backup —
      // the catalogue row is the thing that must not be lost.
    }

    return NextResponse.json({ ok: true, backupId: updated.id, status: updated.status, prunedRows, alerted, slackSent });
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to record backup: ${error instanceof Error ? error.message : "unknown"}` },
      { status: 500 }
    );
  }
}

/**
 * Post a backup event to Slack.
 *
 * Runs alongside the email rather than replacing it: the email reaches the
 * organisation owner, Slack reaches whoever is actually on duty. Failures here
 * are swallowed on purpose — a notification that cannot be delivered must never
 * stop the catalogue row being recorded, which is the thing that matters.
 */
async function notifySlack(db: any, backup: any, kind: "backup_failed" | "backup_empty"): Promise<number> {
  const { buildBackupSlackMessage, resolveSlackWebhooks } = await import("@/lib/backup-slack");

  const site = await db.site.findUnique({
    where: { id: backup.siteId },
    select: { id: true, slug: true, name: true, organizationId: true }
  });
  if (!site) return 0;

  let orgWebhooks: string[] = [];
  try {
    const channels = await db.notificationChannel.findMany({
      where: { organizationId: site.organizationId, provider: "slack", enabled: true },
      select: { config: true }
    });
    orgWebhooks = (channels ?? []).map((c: { config: unknown }) =>
      c.config && typeof c.config === "object" ? (c.config as { webhookUrl?: string }).webhookUrl ?? "" : ""
    );
  } catch {
    // Table missing or unreadable: the platform webhook alone still works.
  }

  const webhooks = resolveSlackWebhooks({
    platformWebhook: process.env.JONGO_SLACK_WEBHOOK_URL,
    orgWebhooks
  });
  if (webhooks.length === 0) return 0;

  const base = (process.env.NEXTAUTH_URL || process.env.APP_BASE_URL || "").replace(/\/+$/, "");
  const siteUrl = `${base}/apps/${encodeURIComponent(site.slug)}/backups`;
  const siteName = site.name || site.slug;

  let lastSuccessAt: Date | null = null;
  if (kind === "backup_failed") {
    const last = await db.siteBackup.findFirst({
      where: { siteId: site.id, status: "success" },
      orderBy: { completedAt: "desc" },
      select: { completedAt: true }
    });
    lastSuccessAt = last?.completedAt ?? null;
  }

  const message =
    kind === "backup_failed"
      ? buildBackupSlackMessage({ kind, siteName, siteUrl, error: backup.error, lastSuccessAt })
      : buildBackupSlackMessage({ kind, siteName, siteUrl, detail: backup.error });

  let sent = 0;
  for (const webhook of webhooks) {
    try {
      const res = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attachments: [
            { color: message.color, title: message.title, text: message.text, fields: message.fields }
          ]
        })
      });
      if (res.ok) sent += 1;
    } catch {
      // Next webhook.
    }
  }
  return sent;
}

// maybeAlertOnFailure lived here: an owner-only failure email, suppressed to one
// per site per 24h. Superseded by notifyBackupEvent above, which mails the whole
// team on every terminal outcome. Removed rather than left dormant so there is
// only one place backup email is sent from.
