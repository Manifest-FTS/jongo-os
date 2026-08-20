import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getSiteWorkspace } from "@/lib/repositories";
import { resolveSitePermissionSnapshot } from "@/lib/permissions";
import { describeDownloadability } from "@/lib/backup-restorability";
import { buildArchiveFilename, buildArchiveScript, isValidSnapshotId } from "@/lib/backup-archive";
import { streamHostScript } from "@/lib/ssh-exec";

export const runtime = "nodejs";
// The whole archive travels inside this one request; a large site is not quick.
export const maxDuration = 3600;
// Nothing here is cacheable, and a cached archive would be a stale copy of a
// site served to whoever asked next.
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ siteId: string; backupId: string }> };

/**
 * Download a backup as a tar archive.
 *
 * GET rather than POST so the browser can navigate to it and stream to disk.
 * A fetch()-based download would have to buffer the whole body in memory before
 * it could be saved, which for a multi-gigabyte site is the difference between
 * working and crashing the tab.
 *
 * The bytes are produced by `restic dump` on the backup host and piped straight
 * through this process — see lib/ssh-exec.ts for why the first byte is awaited
 * before a status code is committed.
 */
export async function GET(_request: Request, { params }: Params) {
  const { siteId, backupId } = await params;

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const workspace = await getSiteWorkspace(siteId, {
    userId: session.user.id,
    email: session.user.email
  });
  if (!workspace) {
    return NextResponse.json({ error: "Not found or insufficient permissions" }, { status: 404 });
  }

  const permissionSnapshot = await resolveSitePermissionSnapshot({
    siteId,
    workspace,
    viewer: { userId: session.user.id, email: session.user.email }
  });
  // The same gate as restore. A download is read-only for the site but it hands
  // over every file and the full database — including wp-config credentials —
  // so it is not a lesser permission than putting that same data back.
  if (!permissionSnapshot.canDownloadBackup) {
    return NextResponse.json({ error: "You do not have permission to download backups" }, { status: 403 });
  }

  const { getDb } = await import("@/lib/db");
  const db = await getDb();
  if (!db || !("siteBackup" in db)) {
    return NextResponse.json(
      { ok: false, reason: "feature_unavailable", message: "Site backup records are not available in this environment yet." },
      { status: 503 }
    );
  }

  const backup = await (db as any).siteBackup.findUnique({ where: { id: backupId } });
  if (!backup || backup.siteId !== workspace.id) {
    return NextResponse.json({ error: "Backup not found for this app." }, { status: 404 });
  }

  const downloadability = describeDownloadability(backup);
  if (!downloadability.downloadable) {
    return NextResponse.json(
      { ok: false, reason: downloadability.reason, message: downloadability.message },
      { status: 409 }
    );
  }

  const snapshotId = String(backup.resticSnapshotId ?? "").trim();
  if (!isValidSnapshotId(snapshotId)) {
    // describeDownloadability only proves an id was recorded, not that it is a
    // restic id. Refuse rather than pass it to a shell on the backup host.
    return NextResponse.json(
      {
        ok: false,
        reason: "invalid_snapshot",
        message: "This backup's offsite reference is not readable, so it cannot be downloaded."
      },
      { status: 409 }
    );
  }

  const stream = await streamHostScript(buildArchiveScript(snapshotId));
  if (!stream.ok) {
    const missingCredentials = stream.stderr.includes("fail_no_b2_creds");
    return NextResponse.json(
      {
        ok: false,
        reason: missingCredentials ? "no_b2_creds" : "archive_failed",
        message: missingCredentials
          ? "Backblaze credentials are missing on the server, so this backup could not be read."
          : "Couldn't read this backup from Backblaze. Your site is untouched.",
        // The operator-facing cause. The message above is what the user sees.
        detail: stream.transportError ?? stream.stderr.slice(0, 2000) ?? undefined
      },
      { status: 502 }
    );
  }

  const filename = buildArchiveFilename({
    siteSlug: workspace.slug,
    siteName: workspace.name,
    startedAt: backup.startedAt
  });

  return new Response(stream.body, {
    status: 200,
    headers: {
      "Content-Type": "application/x-tar",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // No Content-Length: the tar is generated as it streams, and the row's
      // sizeBytes is restic's deduplicated repository figure, not the archive
      // size. A wrong length is worse than none — the client would truncate.
      "Cache-Control": "no-store, no-cache, must-revalidate",
      // Proxies that buffer would defeat the streaming and time the request out.
      "X-Accel-Buffering": "no"
    }
  });
}
