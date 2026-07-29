import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getSiteWorkspace } from "@/lib/repositories";
import { resolveSitePermissionSnapshot } from "@/lib/permissions";
import { normalizeBackupNote } from "@/lib/backup-note";

export const runtime = "nodejs";

type Params = { params: Promise<{ siteId: string; backupId: string }> };

/**
 * Edit a backup's note.
 *
 * A note could previously only be set while creating a backup, which is the one
 * moment you least know what it should say — the reason a snapshot matters is
 * usually discovered later ("this is the one from before the plugin upgrade").
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
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
    if (!permissionSnapshot.canManageBackups) {
      return NextResponse.json(
        { error: "You do not have permission to edit backup notes" },
        { status: 403 }
      );
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    if (!("label" in body)) {
      return NextResponse.json({ error: "label is required." }, { status: 400 });
    }
    const note = normalizeBackupNote(body.label);
    if (note.tooLong) {
      return NextResponse.json(
        { error: `Note is too long — keep it under ${note.maxLength} characters.` },
        { status: 400 }
      );
    }

    const { getDb } = await import("@/lib/db");
    const db = await getDb();
    if (!db || !("siteBackup" in db)) {
      return NextResponse.json(
        { error: "Site backup records are not available in this environment yet." },
        { status: 503 }
      );
    }

    // Scope the update to this site, so a backup id from another workspace can
    // never be edited by guessing it.
    const result = await (db as any).siteBackup.updateMany({
      where: { id: backupId, siteId: workspace.id },
      data: { label: note.value }
    });
    if (!result?.count) {
      return NextResponse.json({ error: "Backup not found for this app." }, { status: 404 });
    }

    return NextResponse.json({ ok: true, label: note.value });
  } catch (error) {
    return NextResponse.json(
      { error: `Could not save the note: ${error instanceof Error ? error.message : "unknown error"}` },
      { status: 500 }
    );
  }
}
