import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getCoolifyAppStagingCapability, isGeneratedCoolifyHost } from "@/lib/coolify";
import { resolveSitePermissionSnapshot } from "@/lib/permissions";
import { getSiteWorkspace } from "@/lib/repositories";
import { retryOnceAfterRateLimitError } from "@/lib/rate-limit-retry";

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
        { relaxedTargetMatch: true }
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
  const stagingUrl = (capability.stagingUrl ?? capability.fqdn?.split(",")[0] ?? "").trim();
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
