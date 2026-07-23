import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { auth } from "@/lib/auth.config";
import { getSiteWorkspace, isClientAdmin } from "@/lib/repositories";
import { openJobLog } from "@/lib/job-log";

export const runtime = "nodejs";

type Params = { params: Promise<{ siteId: string; backupId: string }> };

function resolveScriptPath(name: string): string | null {
  const cwd = process.cwd();
  return [
    path.join(cwd, "scripts", name),
    path.join(cwd, "..", "scripts", name),
    path.join(cwd, "..", "..", "scripts", name)
  ].find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Restore a site from a backup — DESTRUCTIVE: overwrites live files and database.
 *
 * Requires an explicit `confirm: "RESTORE"` in the body so it can never fire
 * from a stray click. The restore script takes a safety snapshot of the current
 * state first, so the restore itself is reversible.
 */
export async function POST(request: Request, ctx: Params) {
  try {
    return await restoreBackup(request, ctx);
  } catch (error) {
    return NextResponse.json(
      { error: `Restore could not be started: ${error instanceof Error ? error.message : "unknown error"}` },
      { status: 500 }
    );
  }
}

async function restoreBackup(request: Request, { params }: Params) {
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

  const isAdmin = Boolean(
    workspace.organizationId && (await isClientAdmin(workspace.organizationId, session.user.id))
  );
  if (!isAdmin) {
    return NextResponse.json({ error: "Only admins can restore backups" }, { status: 403 });
  }

  // Explicit confirmation — this overwrites live site content.
  const body = await request.json().catch(() => ({}));
  if (body?.confirm !== "RESTORE") {
    return NextResponse.json(
      {
        ok: false,
        reason: "confirmation_required",
        message: "Restore overwrites the live site. Send { confirm: \"RESTORE\" } to proceed."
      },
      { status: 428 }
    );
  }

  const { db } = await import("@/lib/db");
  const backup = await db.siteBackup.findUnique({ where: { id: backupId } });

  if (!backup || backup.siteId !== workspace.id) {
    return NextResponse.json({ error: "Backup not found for this app." }, { status: 404 });
  }
  if (backup.status !== "success" || !backup.resticSnapshotId) {
    return NextResponse.json(
      { ok: false, reason: "not_restorable", message: "This backup did not complete successfully and cannot be restored." },
      { status: 409 }
    );
  }

  const scriptPath = resolveScriptPath("site-restore.mjs");
  if (!scriptPath) {
    return NextResponse.json({ error: "Restore script not found." }, { status: 500 });
  }

  // Mark the restore as in-flight so the UI can report completion rather than
  // firing and forgetting. The script clears this via /api/ops/site-restore-record.
  await db.siteBackup.update({
    where: { id: backup.id },
    data: {
      restoreStatus: "running",
      restoreStartedAt: new Date(),
      restoreCompletedAt: null,
      restoreError: null
    }
  });

  // Keep the job detached but preserve its output for diagnosis.

  const jobLog = openJobLog("site-restore");

  const child = spawn(
    process.execPath,
    [
      scriptPath,
      "--resource-uuid", backup.resourceUuid,
      "--snapshot-id", backup.resticSnapshotId,
      "--backup-id", backup.id
    ],
    { cwd: process.cwd(), env: process.env, detached: true, stdio: ["ignore", jobLog, jobLog] }
  );
  child.unref();

  return NextResponse.json(
    {
      ok: true,
      status: "started",
      backupId: backup.id,
      message: "Restore started. The site is briefly offline while files and the database are put back. A safety snapshot of the current state is taken first."
    },
    { status: 202 }
  );
}
