import { NextResponse } from "next/server";
import { describeRestorability } from "@/lib/backup-restorability";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { auth } from "@/lib/auth.config";
import { getSiteWorkspace } from "@/lib/repositories";
import { resolveSitePermissionSnapshot } from "@/lib/permissions";
import { openJobLog } from "@/lib/job-log";

export const runtime = "nodejs";

/**
 * The database backing jongo itself, derived from its own connection string.
 * Coolify exposes internal databases on a hostname that IS the resource uuid,
 * so a dotted host means jongo runs on an external database and no app on the
 * platform can clobber it.
 */
function resolveControlPlaneDatabaseUuid(): string | null {
  const host = (process.env.DATABASE_URL || "").match(/@([^:/?]+)/)?.[1];
  return host && !host.includes(".") ? host : null;
}



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

  const permissionSnapshot = await resolveSitePermissionSnapshot({
    siteId,
    workspace,
    viewer: {
      userId: session.user.id,
      email: session.user.email
    }
  });
  if (!permissionSnapshot.canManageBackups) {
    return NextResponse.json({ error: "You do not have permission to restore backups" }, { status: 403 });
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
  const restorability = describeRestorability(backup);
  if (!restorability.restorable) {
    return NextResponse.json(
      { ok: false, reason: restorability.reason, message: restorability.message },
      { status: 409 }
    );
  }

  // Blast-radius check. Apps that point at a standalone Coolify database do not
  // own it, so restoring the app silently rewrites data other apps depend on —
  // including, for the control-plane app, jongo's own database. Named and
  // acknowledged, never discovered afterwards.
  const resourceUuid = workspace.coolifyServiceUuid?.trim() ?? "";
  if (resourceUuid) {
    try {
      const { resolveCoolifyDatabaseUuids } = await import("@/lib/coolify");
      const { assessSharedDatabaseRestore } = await import("@/lib/shared-database-guard");
      const databaseUuids = await resolveCoolifyDatabaseUuids(resourceUuid);

      if (databaseUuids.length > 0) {
        const allSites = await (db as any).site.findMany({
          where: { deletedAt: null },
          select: { id: true, slug: true, name: true, coolifyServiceUuid: true }
        });
        const assessment = assessSharedDatabaseRestore({
          site: {
            id: workspace.id,
            slug: workspace.slug ?? String(siteId),
            name: workspace.name ?? "",
            coolifyServiceUuid: resourceUuid
          },
          databaseUuids,
          allSites: allSites ?? [],
          controlPlaneDatabaseUuid: resolveControlPlaneDatabaseUuid()
        });

        if (assessment.shared && body?.acknowledgeSharedDatabase !== true) {
          return NextResponse.json(
            {
              ok: false,
              reason: "shared_database",
              message: assessment.warning,
              affected: assessment.affected,
              includesControlPlane: assessment.includesControlPlane
            },
            { status: 409 }
          );
        }
      }
    } catch {
      // A guard that cannot run must not silently disappear: refuse rather than
      // proceed blind into a restore whose blast radius is unknown.
      return NextResponse.json(
        {
          ok: false,
          reason: "shared_database_check_failed",
          message:
            "Could not determine which databases this restore would overwrite, so it was not started. Please try again."
        },
        { status: 503 }
      );
    }
  }

  const scriptPath = resolveScriptPath("site-restore.mjs");
  if (!scriptPath) {
    return NextResponse.json({ error: "Restore script not found." }, { status: 500 });
  }

  // Mark the restore as in-flight so the UI can report completion rather than
  // firing and forgetting. The script clears this via /api/ops/site-restore-record.
  await (db as any).siteBackup.update({
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
      "--backup-id", backup.id,
      // What this backup recorded capturing, so the script can tell a restore
      // that worked from one that exited 0 having applied nothing. Omitted for
      // backups taken before table counting existed — there is nothing to
      // compare against, and a guess would be worse than no check.
      ...(Number(backup.databaseTables) > 0
        ? ["--expect-tables", String(Math.trunc(Number(backup.databaseTables)))]
        : [])
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
