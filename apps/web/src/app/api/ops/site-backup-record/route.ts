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
        posts: int(body.posts),
        pages: int(body.pages),
        plugins: int(body.plugins),
        comments: int(body.comments),
        wpVersion: str(body.wpVersion),
        error: str(body.error),
        completedAt: new Date()
      }
    });

    return NextResponse.json({ ok: true, backupId: updated.id, status: updated.status });
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to record backup: ${error instanceof Error ? error.message : "unknown"}` },
      { status: 500 }
    );
  }
}
