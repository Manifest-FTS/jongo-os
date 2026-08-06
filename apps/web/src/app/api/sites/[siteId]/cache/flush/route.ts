import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { auth } from "@/lib/auth.config";
import { getSiteWorkspace } from "@/lib/repositories";
import { resolveSitePermissionSnapshot } from "@/lib/permissions";

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
 * Flush a site's caches.
 *
 * Runs SYNCHRONOUSLY, unlike backups and restores. Those are long enough that
 * firing them detached and reporting later is the only option; a cache flush
 * takes seconds, and the entire point of this endpoint is to tell the caller
 * what was actually cleared. Answering "started" would recreate the bug it
 * replaces — a button that reports success before anything has happened.
 */
export async function POST(_request: Request, ctx: Params) {
  try {
    return await flushCache(ctx);
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: `Cache flush failed: ${error instanceof Error ? error.message : "unknown error"}` },
      { status: 500 }
    );
  }
}

async function flushCache({ params }: Params) {
  const { siteId } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
  }

  const workspace = await getSiteWorkspace(siteId, {
    userId: session.user.id,
    email: session.user.email
  });
  if (!workspace) {
    return NextResponse.json({ ok: false, message: "Not found or insufficient permissions" }, { status: 404 });
  }

  // Same bar as the other write action on this panel (the domain slug save).
  const permissionSnapshot = await resolveSitePermissionSnapshot({
    siteId,
    workspace,
    viewer: { userId: session.user.id, email: session.user.email }
  });
  if (!permissionSnapshot.canManageDomains) {
    return NextResponse.json(
      { ok: false, message: "You do not have permission to flush this app's cache." },
      { status: 403 }
    );
  }

  const resourceUuid = workspace.coolifyServiceUuid?.trim();
  if (!resourceUuid) {
    return NextResponse.json(
      { ok: false, message: "This app is not linked to a Coolify resource." },
      { status: 409 }
    );
  }

  if (!hasValue(process.env.STAGING_SYNC_SSH_HOST) && !hasValue(process.env.COOLIFY_SSH_HOST)) {
    return NextResponse.json(
      { ok: false, message: "SSH host is not configured, so the cache cannot be flushed from here." },
      { status: 412 }
    );
  }

  const scriptPath = resolveScriptPath("site-cache-flush.mjs");
  if (!scriptPath) {
    return NextResponse.json({ ok: false, message: "Cache flush script not found." }, { status: 500 });
  }

  const result = await new Promise<{ stdout: string; stderr: string; failed: boolean }>((resolve) => {
    execFile(
      process.execPath,
      [scriptPath, "--resource-uuid", resourceUuid],
      { cwd: process.cwd(), env: process.env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // A non-zero exit is expected when nothing could be flushed, so the
        // payload below is what decides the outcome — not the exit code.
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", failed: Boolean(error) });
      }
    );
  });

  const line = result.stdout
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.startsWith("SITE_CACHE_FLUSH_RESULT="));

  if (!line) {
    // The script produced no verdict — never guess one. Reporting a flush we
    // cannot evidence is the exact failure this endpoint exists to remove.
    console.error("cache flush produced no result line:", result.stderr.slice(0, 2000));
    return NextResponse.json(
      { ok: false, message: "The cache flush did not report a result, so it cannot be confirmed as done." },
      { status: 502 }
    );
  }

  try {
    const payload = JSON.parse(line.slice("SITE_CACHE_FLUSH_RESULT=".length));
    return NextResponse.json(payload, { status: payload?.ok ? 200 : 409 });
  } catch {
    return NextResponse.json(
      { ok: false, message: "The cache flush result could not be read, so it cannot be confirmed as done." },
      { status: 502 }
    );
  }
}
