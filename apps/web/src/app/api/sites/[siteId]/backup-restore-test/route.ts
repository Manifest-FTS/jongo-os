import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { auth } from "@/lib/auth.config";
import { isAdminRole } from "@/lib/roles";

export const runtime = "nodejs";

type Params = { params: Promise<{ siteId: string }> };

function normalizeEmail(value?: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

function hasValue(value?: string | null): boolean {
  return Boolean(value && value.trim().length > 0);
}

// scripts/ sits at the repo root; the built app runs from apps/web.
function resolveVerifyScriptPath(): string | null {
  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, "scripts", "verify-jongo-backup.mjs"),
    path.join(cwd, "..", "scripts", "verify-jongo-backup.mjs"),
    path.join(cwd, "..", "..", "scripts", "verify-jongo-backup.mjs")
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Trigger a one-click restore TEST for this app's database. Restores the latest
 * offsite dump into an isolated throwaway container, verifies row counts, and
 * records the outcome (which drives the "Restore verified" chip). It never
 * touches the live database — production recovery is deliberately not one-click.
 *
 * Runs detached and returns 202: the restore can take minutes, and the script
 * records its own result via /api/ops/backup-restore-verification when it
 * finishes, so the chip updates on the next page load.
 */
export async function POST(_request: Request, { params }: Params) {
  const { siteId } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { db } = await import("@/lib/db");
  const site = await db.site.findFirst({
    where: {
      OR: [{ id: siteId }, { slug: siteId }],
      deletedAt: null
    },
    include: {
      organization: {
        select: {
          ownerId: true,
          collaborators: { where: { userId: session.user.id }, select: { role: true } }
        }
      }
    }
  });

  if (!site) {
    return NextResponse.json({ error: "Not found or insufficient permissions" }, { status: 404 });
  }

  const bootstrapAdmin = normalizeEmail(process.env.BOOTSTRAP_ADMIN_EMAIL);
  const callerIsOwner = site.organization.ownerId === session.user.id;
  const callerIsBootstrap = Boolean(bootstrapAdmin && normalizeEmail(session.user.email) === bootstrapAdmin);
  const callerIsAdmin =
    callerIsOwner || callerIsBootstrap || isAdminRole(site.organization.collaborators[0]?.role);
  if (!callerIsAdmin) {
    return NextResponse.json({ error: "Only admins can run restore tests" }, { status: 403 });
  }

  const resourceUuid = site.coolifyServiceUuid?.trim();
  if (!resourceUuid) {
    return NextResponse.json({ error: "This app is not linked to a Coolify resource." }, { status: 409 });
  }

  // The restore test needs the DB user to read ground-truth row counts, and we
  // will not guess it per-resource. Only the configured backup-testable DB is
  // eligible. Set JONGO_DB_CONTAINER / JONGO_DB_USER in the app environment.
  const configuredContainer = (process.env.JONGO_DB_CONTAINER || "").trim();
  const configuredUser = (process.env.JONGO_DB_USER || "").trim();
  if (!configuredContainer || !configuredUser) {
    return NextResponse.json(
      { ok: false, reason: "not_configured", message: "Restore testing is not configured (JONGO_DB_CONTAINER / JONGO_DB_USER unset)." },
      { status: 412 }
    );
  }
  if (resourceUuid !== configuredContainer) {
    return NextResponse.json(
      { ok: false, reason: "resource_not_eligible", message: "Restore testing is only configured for the platform database, not this resource." },
      { status: 412 }
    );
  }

  if (!hasValue(process.env.STAGING_SYNC_SSH_HOST) && !hasValue(process.env.COOLIFY_SSH_HOST)) {
    return NextResponse.json(
      { ok: false, reason: "missing_config", message: "SSH host is not configured for server-side restore testing." },
      { status: 412 }
    );
  }

  const scriptPath = resolveVerifyScriptPath();
  if (!scriptPath) {
    return NextResponse.json({ error: "Restore-test script not found." }, { status: 500 });
  }

  // Detached: the script records its own result when it completes.
  const child = spawn(process.execPath, [scriptPath, "--restore-test"], {
    cwd: process.cwd(),
    env: { ...process.env, JONGO_DB_CONTAINER: configuredContainer, JONGO_DB_USER: configuredUser },
    detached: true,
    stdio: "ignore"
  });
  child.unref();

  return NextResponse.json(
    {
      ok: true,
      status: "started",
      resourceUuid,
      message: "Restore test started. It restores into an isolated container; the result appears here in a few minutes."
    },
    { status: 202 }
  );
}
