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
    const updated = await db.siteBackup.update({
      where: { id: backupId },
      data: {
        status,
        resticSnapshotId: str(body.resticSnapshotId),
        sizeBytes: sizeBytes === null ? null : BigInt(sizeBytes),
        resourceType: str(body.resourceType),
        volumeCount: int(body.volumeCount),
        databaseCount: int(body.databaseCount),
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
    const forgotten = Array.isArray(body.forgottenSnapshotIds)
      ? body.forgottenSnapshotIds.map((v) => String(v).trim()).filter(Boolean)
      : [];
    if (forgotten.length > 0) {
      const result = await db.siteBackup.updateMany({
        where: { resticSnapshotId: { in: forgotten }, status: "success" },
        data: { status: "pruned" }
      });
      prunedRows = result?.count ?? 0;
    }

    // A scheduled backup fails into a log nobody reads, so a customer can
    // believe they are protected while they are not. Alert on that; on-demand
    // failures already surface as a toast to whoever pressed the button.
    let alerted = false;
    try {
      alerted = await maybeAlertOnFailure(db, updated);
    } catch {
      // Never let alerting failure mask a successfully recorded backup —
      // the catalogue row is the thing that must not be lost.
    }

    return NextResponse.json({ ok: true, backupId: updated.id, status: updated.status, prunedRows, alerted });
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to record backup: ${error instanceof Error ? error.message : "unknown"}` },
      { status: 500 }
    );
  }
}

/**
 * Email the organisation owner when a scheduled backup fails. Returns whether
 * an email was actually sent, which the caller reports for observability.
 */
async function maybeAlertOnFailure(db: any, backup: any): Promise<boolean> {
  const { shouldAlertOnBackupFailure, buildBackupFailureEmail } = await import("@/lib/backup-alert");

  const site = await db.site.findUnique({
    where: { id: backup.siteId },
    select: {
      id: true,
      slug: true,
      name: true,
      backupAlertSentAt: true,
      organization: { select: { owner: { select: { email: true } } } }
    }
  });
  if (!site) return false;

  const decision = shouldAlertOnBackupFailure({
    status: backup.status,
    trigger: backup.trigger,
    lastAlertAt: site.backupAlertSentAt
  });
  if (!decision.alert) return false;

  const to = site.organization?.owner?.email?.trim();
  if (!to) return false;

  // Point at the most recent snapshot they CAN still restore, so the email
  // answers "am I exposed right now?" and not just "something broke".
  const lastSuccess = await db.siteBackup.findFirst({
    where: { siteId: site.id, status: "success" },
    orderBy: { completedAt: "desc" },
    select: { completedAt: true }
  });

  const base = (process.env.NEXTAUTH_URL || process.env.APP_BASE_URL || "").replace(/\/+$/, "");
  const { sendTransactionalEmail } = await import("@/lib/email");
  const message = buildBackupFailureEmail({
    siteName: site.name || site.slug,
    siteUrl: `${base}/apps/${encodeURIComponent(site.slug)}/backups`,
    failedAt: backup.completedAt ? new Date(backup.completedAt) : new Date(),
    error: backup.error,
    lastSuccessAt: lastSuccess?.completedAt ?? null
  });

  const result = await sendTransactionalEmail({ to, subject: message.subject, text: message.text });
  if (!result.sent) return false;

  // Only stamp on a send that actually happened, so a misconfigured mailer
  // does not silently burn the alert for the next 24 hours.
  await db.site.update({ where: { id: site.id }, data: { backupAlertSentAt: new Date() } });
  return true;
}
