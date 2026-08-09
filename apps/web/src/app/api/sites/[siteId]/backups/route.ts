import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getSiteWorkspace } from "@/lib/repositories";
import { resolveSitePermissionSnapshot } from "@/lib/permissions";
import { normalizeBackupNote } from "@/lib/backup-note";
import { startSiteBackup } from "@/lib/site-backup-start";

export const runtime = "nodejs";

type Params = { params: Promise<{ siteId: string }> };

/**
 * Create an on-demand backup ("+"): captures WordPress files + a database dump
 * into a single restic snapshot in Backblaze B2, plus content metadata.
 *
 * Returns 202 immediately — the backup runs detached and reports its result to
 * /api/ops/site-backup-record when finished.
 */
export async function POST(request: Request, ctx: Params) {
  try {
    return await createBackup(request, ctx);
  } catch (error) {
    return NextResponse.json(
      { error: `Backup could not be started: ${error instanceof Error ? error.message : "unknown error"}` },
      { status: 500 }
    );
  }
}

async function createBackup(request: Request, { params }: Params) {
  const { siteId } = await params;
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
    viewer: {
      userId: session.user.id,
      email: session.user.email
    }
  });
  if (!permissionSnapshot.canManageBackups) {
    return NextResponse.json({ error: "You do not have permission to create backups" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  // Same rule as editing a note afterwards, so the two paths cannot disagree.
  const label = normalizeBackupNote(body?.label).value;

  const started = await startSiteBackup({
    site: {
      id: workspace.id,
      slug: workspace.slug,
      name: workspace.name,
      coolifyServiceUuid: workspace.coolifyServiceUuid
    },
    trigger: "manual",
    label
  });

  if (started.ok) {
    return NextResponse.json(
      {
        ok: true,
        status: "started",
        backupId: started.backupId,
        message: started.message
      },
      { status: 202 }
    );
  }

  // Response shapes are preserved per reason: the Backups panel branches on
  // `reason`, and two of these predate it and report via `error` instead.
  switch (started.reason) {
    case "not_linked":
      return NextResponse.json({ error: started.message }, { status: 409 });
    case "script_missing":
      return NextResponse.json({ error: started.message }, { status: 500 });
    case "unsupported_resource_type":
    case "missing_config":
      return NextResponse.json({ ok: false, reason: started.reason, message: started.message }, { status: 412 });
    case "feature_unavailable":
      return NextResponse.json({ ok: false, reason: started.reason, message: started.message }, { status: 503 });
    case "already_running":
      return NextResponse.json({ ok: false, reason: started.reason, message: started.message }, { status: 409 });
  }
}
