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

/**
 * The public hostname of the resource being flushed.
 *
 * Read from the cached Coolify overview by resource uuid, so it is correct for
 * a staging flush as well as production, and costs no extra Coolify call.
 */
async function resolveFlushDomain(resourceUuid: string): Promise<string> {
  try {
    const { getCoolifyOverview } = await import("@/lib/coolify");
    const overview = await getCoolifyOverview();
    const match = overview.sites.find(
      (site) => site.id === resourceUuid || site.deployTargetId === resourceUuid
    );
    return match?.primaryDomain ?? "";
  } catch {
    // No domain means the Cloudflare step reports "absent", which is the right
    // answer: we cannot know which zone to purge.
    return "";
  }
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
export async function POST(request: Request, ctx: Params) {
  try {
    return await flushCache(request, ctx);
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: `Cache flush failed: ${error instanceof Error ? error.message : "unknown error"}` },
      { status: 500 }
    );
  }
}

async function flushCache(request: Request, { params }: Params) {
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

  // Collaborators included. This used to reuse canManageDomains — the bar for
  // the domain slug save — which made it admin-only, while both panels that
  // offer the button rendered it enabled for anyone signed in. A collaborator
  // therefore got a 403 from a live-looking button. A flush is non-destructive
  // and its own capability now, so the gate and the UI agree.
  const permissionSnapshot = await resolveSitePermissionSnapshot({
    siteId,
    workspace,
    viewer: { userId: session.user.id, email: session.user.email }
  });
  if (!permissionSnapshot.canFlushCache) {
    return NextResponse.json(
      { ok: false, message: "You do not have permission to flush this app's cache." },
      { status: 403 }
    );
  }

  // Which copy of the site to flush. Staging has its own containers and its
  // own cache; flushing production when the operator asked for staging would
  // clear the wrong site AND leave the stale pages they were looking at.
  const body = await request.json().catch(() => ({}));
  const target = body?.target === "staging" ? "staging" : "production";

  let resourceUuid = workspace.coolifyServiceUuid?.trim();

  if (target === "staging") {
    if (!resourceUuid) {
      return NextResponse.json(
        { ok: false, message: "This app is not linked to a Coolify resource." },
        { status: 409 }
      );
    }
    const { getCoolifyAppStagingCapability } = await import("@/lib/coolify");
    const capability = await getCoolifyAppStagingCapability(
      resourceUuid,
      workspace.coolifyProjectId ?? undefined,
      { relaxedTargetMatch: true }
    );
    const stagingUuid = capability?.applicationUuid?.trim();
    if (!stagingUuid) {
      // Never silently fall back to production: the operator asked for
      // staging, and flushing the live site instead would be both wrong and
      // invisible.
      return NextResponse.json(
        { ok: false, message: "No staging copy was found for this app, so there is no staging cache to flush." },
        { status: 409 }
      );
    }
    resourceUuid = stagingUuid;
  }

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
        // The exit code is deliberately not consulted: the payload below is the
        // authority on what happened, and it distinguishes outcomes the exit
        // code cannot (nothing to flush vs. a flush that failed).
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

    // Fourth target: Cloudflare's edge. It needs no host access, so it runs
    // here rather than in the script, and the verdict is re-derived over all
    // four. Without this a site behind a CDN could be told every cache was
    // flushed while the public URL still served a stale copy from the edge.
    const { purgeCloudflareCache } = await import("@/lib/cloudflare-purge");
    const { describeCacheFlush } = await import("@/lib/cache-flush");

    const purge = await purgeCloudflareCache(await resolveFlushDomain(resourceUuid));

    const combined = describeCacheFlush({
      wpCli: payload?.targets?.wpCli ?? null,
      fileCache: payload?.targets?.fileCache ?? null,
      redis: payload?.targets?.redis ?? null,
      cloudflare: purge.status
    });

    return NextResponse.json(
      {
        ...payload,
        ok: combined.flushed,
        reason: combined.reason,
        message: combined.message,
        details: combined.details,
        targets: { ...(payload?.targets ?? {}), cloudflare: purge.status },
        // Named so a shared zone is visible rather than surprising, and so a
        // refused purge says why.
        cloudflare:
          purge.status === "flushed"
            ? { status: purge.status, zone: purge.zone }
            : { status: purge.status, reason: (purge as { reason?: string }).reason ?? null }
      },
      { status: combined.flushed ? 200 : 409 }
    );
  } catch {
    return NextResponse.json(
      { ok: false, message: "The cache flush result could not be read, so it cannot be confirmed as done." },
      { status: 502 }
    );
  }
}
