import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { auth } from "@/lib/auth.config";
import { isAdminRole } from "@/lib/roles";
import { getCoolifyAppBackupInventory } from "@/lib/coolify";

export const runtime = "nodejs";

type Params = { params: Promise<{ siteId: string }> };

function normalizeEmail(value?: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

function hasValue(value?: string | null): boolean {
  return Boolean(value && value.trim().length > 0);
}

// scripts/ sits at the repo root; the built app runs from apps/web.
function resolveScriptPath(name: string): string | null {
  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, "scripts", name),
    path.join(cwd, "..", "scripts", name),
    path.join(cwd, "..", "..", "scripts", name)
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

  const appUuid = site.coolifyServiceUuid?.trim();
  if (!appUuid) {
    return NextResponse.json({ error: "This app is not linked to a Coolify resource." }, { status: 409 });
  }

  if (!hasValue(process.env.STAGING_SYNC_SSH_HOST) && !hasValue(process.env.COOLIFY_SSH_HOST)) {
    return NextResponse.json(
      { ok: false, reason: "missing_config", message: "SSH host is not configured for server-side restore testing." },
      { status: 412 }
    );
  }

  // Resolve THIS app's own database resource (container UUID + engine) from the
  // Coolify backup inventory. Prefer one with a successful backup to restore.
  const inventory = await getCoolifyAppBackupInventory(appUuid);
  const coverage = inventory.databaseCoverage ?? [];
  const target =
    coverage.find((c) => c.hasSuccessfulExecution) ??
    coverage.find((c) => c.hasSchedule) ??
    coverage[0];

  if (!target) {
    return NextResponse.json(
      { ok: false, reason: "no_database", message: "No backed-up database was found for this app." },
      { status: 412 }
    );
  }

  const scriptPath = resolveScriptPath("restore-test-resource.mjs");
  if (!scriptPath) {
    return NextResponse.json({ error: "Restore-test script not found." }, { status: 500 });
  }

  // Detached: the script records its own result when it completes.
  const child = spawn(
    process.execPath,
    [scriptPath, "--resource-uuid", target.resourceId, "--engine", target.engine],
    { cwd: process.cwd(), env: process.env, detached: true, stdio: "ignore" }
  );
  child.unref();

  return NextResponse.json(
    {
      ok: true,
      status: "started",
      resourceUuid: target.resourceId,
      engine: target.engine,
      message: `Restore test started for ${target.resourceName}. It restores into an isolated container; the result appears here in a few minutes.`
    },
    { status: 202 }
  );
}
