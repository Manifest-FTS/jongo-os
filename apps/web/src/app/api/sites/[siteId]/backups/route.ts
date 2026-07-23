import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { auth } from "@/lib/auth.config";
import { getSiteWorkspace, isClientAdmin } from "@/lib/repositories";
import { isCoolifyWordPressService } from "@/lib/coolify";
import { openJobLog } from "@/lib/job-log";

export const runtime = "nodejs";

type Params = { params: Promise<{ siteId: string }> };

function hasValue(value?: string | null): boolean {
  return Boolean(value && value.trim().length > 0);
}

function resolveScriptPath(name: string): string | null {
  const cwd = process.cwd();
  return [
    path.join(cwd, "scripts", name),
    path.join(cwd, "..", "scripts", name),
    path.join(cwd, "..", "..", "scripts", name)
  ].find((candidate) => existsSync(candidate)) ?? null;
}

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

  const isAdmin = Boolean(
    workspace.organizationId && (await isClientAdmin(workspace.organizationId, session.user.id))
  );
  if (!isAdmin) {
    return NextResponse.json({ error: "Only admins can create backups" }, { status: 403 });
  }

  const resourceUuid = workspace.coolifyServiceUuid?.trim();
  if (!resourceUuid) {
    return NextResponse.json({ error: "This app is not linked to a Coolify resource." }, { status: 409 });
  }

  // Full-site backup captures a WordPress files volume + its database. Confirm
  // this Coolify resource actually has a WordPress container (via its `wordpress`
  // application) rather than trusting the unreliable siteType heuristic — that
  // both flags non-WordPress apps and misses real WordPress services.
  if (!(await isCoolifyWordPressService(resourceUuid))) {
    return NextResponse.json(
      {
        ok: false,
        reason: "unsupported_resource_type",
        message: "Full-site backups are only available for WordPress apps."
      },
      { status: 412 }
    );
  }

  if (!hasValue(process.env.STAGING_SYNC_SSH_HOST) && !hasValue(process.env.COOLIFY_SSH_HOST)) {
    return NextResponse.json(
      { ok: false, reason: "missing_config", message: "SSH host is not configured for server-side backups." },
      { status: 412 }
    );
  }

  const scriptPath = resolveScriptPath("site-backup.mjs");
  if (!scriptPath) {
    return NextResponse.json({ error: "Backup script not found." }, { status: 500 });
  }

  const body = await request.json().catch(() => ({}));
  const label = typeof body?.label === "string" && body.label.trim() ? body.label.trim().slice(0, 200) : null;

  const { db } = await import("@/lib/db");

  // Refuse to stack concurrent backups for the same site.
  const running = await db.siteBackup.findFirst({
    where: { siteId: workspace.id, status: "running" }
  });
  if (running) {
    return NextResponse.json(
      { ok: false, reason: "already_running", message: "A backup is already running for this app." },
      { status: 409 }
    );
  }

  const record = await db.siteBackup.create({
    data: {
      siteId: workspace.id,
      resourceUuid,
      label,
      trigger: "manual",
      status: "running"
    }
  });

  // Keep the job detached but preserve its output for diagnosis.

  const jobLog = openJobLog("site-backup");

  const child = spawn(
    process.execPath,
    [
      scriptPath,
      "--resource-uuid", resourceUuid,
      "--backup-id", record.id,
      ...(label ? ["--label", label] : [])
    ],
    { cwd: process.cwd(), env: process.env, detached: true, stdio: ["ignore", jobLog, jobLog] }
  );
  child.unref();

  return NextResponse.json(
    {
      ok: true,
      status: "started",
      backupId: record.id,
      message: "Backup started — files and database are being captured to Backblaze. It will appear in the list shortly."
    },
    { status: 202 }
  );
}
