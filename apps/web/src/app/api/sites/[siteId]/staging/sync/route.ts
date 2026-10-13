import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getCoolifyAppStagingCapability, isGeneratedCoolifyHost } from "@/lib/coolify";
import { resolveSitePermissionSnapshot } from "@/lib/permissions";
import { getSiteWorkspace } from "@/lib/repositories";
import { retryOnceAfterRateLimitError } from "@/lib/rate-limit-retry";
import { primaryStagingUrl } from "@/lib/staging-domains";
import { pickFallbackHost, platformSuffixesFromEnv } from "@/lib/staging-domain-rules";

export const runtime = "nodejs";

type Params = { params: Promise<{ siteId: string }> };

type SyncResponse = {
  ok?: boolean;
  message?: string;
  error?: string;
  reason?: string;
};

export async function POST(request: Request, { params }: Params) {
  const { siteId } = await params;
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
  }

  const viewer = { userId: session.user.id, email: session.user.email };
  const workspace = await getSiteWorkspace(siteId, viewer);
  if (!workspace) {
    return NextResponse.json({ ok: false, message: "Not found or insufficient permissions" }, { status: 404 });
  }

  const permissions = await resolveSitePermissionSnapshot({ siteId, workspace, viewer });
  if (!permissions.canSyncStaging) {
    return NextResponse.json(
      { ok: false, message: "You do not have permission to sync this staging site." },
      { status: 403 }
    );
  }

  const productionServiceUuid = workspace.coolifyServiceUuid?.trim();
  if (!workspace.stagingEnabled || !productionServiceUuid) {
    return NextResponse.json(
      { ok: false, message: "Staging is not enabled or the production service is not linked." },
      { status: 409 }
    );
  }

  let capability;
  try {
    capability = await retryOnceAfterRateLimitError(() =>
      getCoolifyAppStagingCapability(
        productionServiceUuid,
        workspace.coolifyProjectId ?? undefined,
        // Strict: sync overwrites the staging copy it finds. Recorded copies
        // are found first; a lone unrelated copy must never be adopted.
        { relaxedTargetMatch: false }
      )
    );
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message: error instanceof Error
          ? `Staging could not be resolved: ${error.message}`
          : "Staging could not be resolved."
      },
      { status: 503 }
    );
  }

  const stagingServiceUuid = capability.applicationUuid?.trim();

  // Apps (Next.js, Sanity, …): staging has its own database, and syncing means
  // replacing it with a fresh copy of production's. The WordPress content sync
  // below only knows wordpress-<uuid> containers.
  if (stagingServiceUuid && capability.resourceKind === "application") {
    const { writeStagingTargetPin } = await import("@/lib/staging-target-pin");
    await writeStagingTargetPin(workspace.id, stagingServiceUuid);
    const { ensureStagingDatabases } = await import("@/lib/staging-databases");
    const result = await ensureStagingDatabases(workspace.id);
    try {
      const { db } = await import("@/lib/db");
      await db.auditLog.create({
        data: {
          organizationId: workspace.organizationId,
          actorId: session.user.id,
          action: "site_updated",
          resourceType: "site_staging",
          resourceId: workspace.id,
          details: {
            actionType: result.ok ? "staging_synced_from_production" : "staging_sync_failed",
            productionServiceUuid,
            stagingServiceUuid,
            direction: "production-to-staging",
            databases: result.databases,
            message: result.message
          },
          ipAddress: request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? "unknown",
          userAgent: request.headers.get("user-agent") ?? undefined
        }
      });
    } catch (error) {
      console.error("staging sync: audit log write failed", error);
    }
    return NextResponse.json(
      result.ok
        ? { ok: true, message: result.message }
        : { ok: false, message: result.message, remedy: { action: "retry_staging_database", label: "Try again" } },
      { status: result.ok ? 200 : 409 }
    );
  }
  // Production content is rewritten to THE staging link: a connected custom
  // domain when there is one, else the .mfts.link fallback.
  const fallbackHost = pickFallbackHost(String(capability.fqdn ?? capability.stagingUrl ?? "").split(","), platformSuffixesFromEnv());
  const fallbackStagingUrl = fallbackHost ? `https://${fallbackHost}` : (capability.stagingUrl ?? capability.fqdn?.split(",")[0] ?? "").trim();
  const stagingUrl = ((await primaryStagingUrl(workspace.id, fallbackStagingUrl)) ?? fallbackStagingUrl).trim();
  if (!stagingServiceUuid || !stagingUrl) {
    return NextResponse.json(
      { ok: false, message: "The staging target or its public URL is not available yet. Retry shortly." },
      { status: 409 }
    );
  }

  if (isGeneratedCoolifyHost(stagingUrl, stagingServiceUuid)) {
    return NextResponse.json(
      { ok: false, message: "The preferred staging URL is not active yet. Retry after domain setup completes." },
      { status: 409 }
    );
  }

  const automationUrl = (process.env.STAGING_SYNC_AUTOMATION_URL || "").trim();
  const token = (process.env.OWNERSHIP_SYNC_TOKEN || "").trim();
  if (!automationUrl) {
    return NextResponse.json(
      { ok: false, message: "Staging content sync is not configured." },
      { status: 412 }
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10 * 60_000);

  try {
    const response = await fetch(automationUrl, {
      method: "POST",
      signal: controller.signal,
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({
        siteId: workspace.id,
        productionServiceUuid,
        stagingServiceUuid,
        stagingUrl,
        direction: "production-to-staging",
        appBaseUrl: new URL(request.url).origin,
        mode: "apply"
      })
    });

    const payload = await response.json().catch(() => ({})) as SyncResponse;
    if (!response.ok || !payload.ok) {
      return NextResponse.json(
        { ok: false, message: payload.message ?? payload.error ?? "Staging content sync failed." },
        { status: response.ok ? 409 : response.status }
      );
    }

    // Record the sync so the staging page can say when it last happened. The
    // page had no source for "last synced from production" because nothing was
    // ever written here. Logging must never turn a successful sync into a
    // failure, so it is best-effort.
    try {
      const { db } = await import("@/lib/db");
      await db.auditLog.create({
        data: {
          organizationId: workspace.organizationId,
          actorId: session.user.id,
          action: "site_updated",
          resourceType: "site_staging",
          resourceId: workspace.id,
          details: {
            actionType: "staging_synced_from_production",
            productionServiceUuid,
            stagingServiceUuid,
            stagingUrl,
            direction: "production-to-staging",
            message: payload.message ?? "Production content was synced to staging."
          },
          ipAddress: request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? "unknown",
          userAgent: request.headers.get("user-agent") ?? undefined
        }
      });
    } catch (error) {
      console.error("staging sync: audit log write failed", error);
    }

    return NextResponse.json({
      ok: true,
      message: payload.message ?? "Production content was synced to staging."
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message: error instanceof Error && error.name === "AbortError"
          ? "Staging content sync timed out. Check staging before retrying."
          : "Staging content sync could not reach the automation service."
      },
      { status: 504 }
    );
  } finally {
    clearTimeout(timeout);
  }
}
