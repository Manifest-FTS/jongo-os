import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Callback for scripts/site-restore.mjs — records how a restore finished,
 * including the safety snapshot id used for rollback.
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

  const str = (value: unknown): string | null =>
    typeof value === "string" && value.trim() ? value.trim() : null;

  try {
    const { db } = await import("@/lib/db");
    const updated = await db.siteBackup.update({
      where: { id: backupId },
      data: {
        restoreStatus: status,
        restoreCompletedAt: new Date(),
        restoreError: str(body.error),
        safetySnapshotId: str(body.safetySnapshot)
      }
    });
    return NextResponse.json({ ok: true, backupId: updated.id, restoreStatus: updated.restoreStatus });
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to record restore: ${error instanceof Error ? error.message : "unknown"}` },
      { status: 500 }
    );
  }
}
