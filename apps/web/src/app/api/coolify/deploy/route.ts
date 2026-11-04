import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { publicDeployView, requestSiteDeploy, SITE_DEPLOY_KIND } from "@/lib/deploy-operation";
import { enqueueOperationRun } from "@/lib/job-queue";
import { failOperation } from "@/lib/operations";
import { getPermissions } from "@/lib/permissions";
import { resolveSiteAccess } from "@/lib/tenant-route-access";

export const runtime = "nodejs";

/**
 * Redeploy an app the caller has access to.
 *
 * Returns 202 with an operation to follow (GET /api/operations/{id}); the
 * worker does the deploy. A second request while one is queued or running
 * returns that same operation instead of deploying twice.
 *
 * The caller names a Jongo site, never a hosting resource: the resource to
 * deploy is read from that site's own record after the tenant check. This route
 * used to accept any `serviceUuid` from the browser and deploy it unchecked, so
 * one client could redeploy another client's app — or anything else on the
 * hosting server — by sending its id.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const input = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const siteId = typeof input.siteId === "string" ? input.siteId.trim() : "";
  if (!siteId) {
    return NextResponse.json({ error: "Choose an app to deploy." }, { status: 400 });
  }
  const environment = input.environment === "staging" ? "staging" : "production";

  const access = await resolveSiteAccess(siteId, userId);
  if (!access) {
    // Same answer whether the app does not exist or belongs to someone else.
    return NextResponse.json({ error: "App not found." }, { status: 404 });
  }

  const permissions = getPermissions(access.isAdmin ? "admin" : "collaborator", access.isPlatformAdmin);
  if (!permissions.canDeployFromGithub) {
    return NextResponse.json({ error: "You don't have permission to deploy this app." }, { status: 403 });
  }

  const { db } = await import("@/lib/db");
  const site = await db.site.findUnique({
    where: { id: access.site.id },
    select: { id: true, organizationId: true, coolifyServiceUuid: true, stagingTargetUuid: true }
  });

  const targetUuid = (environment === "staging" ? site?.stagingTargetUuid : site?.coolifyServiceUuid)?.trim() ?? "";
  if (!site || !targetUuid) {
    return NextResponse.json(
      {
        error:
          environment === "staging"
            ? "This app has no staging copy to deploy."
            : "This app isn't connected to hosting yet, so it can't be deployed."
      },
      { status: 409 }
    );
  }

  // Queue the deploy (or join the one already running) and return at once.
  // The worker starts it in hosting and follows it; see lib/deploy-operation.ts.
  let operation;
  let created = false;
  try {
    ({ operation, created } = await requestSiteDeploy({
      siteId: site.id,
      organizationId: site.organizationId,
      environment,
      actorId: userId
    }));
  } catch (error) {
    console.error("[deploy] could not create operation", { siteId: site.id, environment, error });
    return NextResponse.json({ error: "The deploy couldn't be started. Try again shortly." }, { status: 503 });
  }

  if (created) {
    try {
      await enqueueOperationRun(operation.id);
    } catch (error) {
      console.error("[deploy] could not queue operation", { operationId: operation.id, error });
      await failOperation(operation.id, "The deploy couldn't be started. Try again shortly.").catch(() => undefined);
      return NextResponse.json({ error: "The deploy couldn't be started. Try again shortly." }, { status: 503 });
    }

    // Best-effort: the deploy is queued and must not be reported as failed
    // because an audit row could not be written.
    try {
      await db.auditLog.create({
        data: {
          organizationId: site.organizationId,
          actorId: userId,
          action: "deploy_triggered",
          resourceType: "site",
          resourceId: site.id,
          details: { environment, operationId: operation.id },
          ipAddress: req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for") ?? null,
          userAgent: req.headers.get("user-agent") ?? null
        }
      });
    } catch (error) {
      console.error("[deploy] could not write audit log", { siteId: site.id, error });
    }
  }

  return NextResponse.json(
    {
      operation: publicDeployView(operation),
      alreadyRunning: !created,
      message: created ? "Deploy queued." : "A deploy of this app is already in progress."
    },
    { status: 202 }
  );
}

/**
 * GET /api/coolify/deploy?siteId=…&environment=… — the latest deploy of this
 * app (running, or finished in the last 10 minutes), so the button can show
 * progress again after a page reload.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }
  const siteId = req.nextUrl.searchParams.get("siteId")?.trim() ?? "";
  const environment = req.nextUrl.searchParams.get("environment") === "staging" ? "staging" : "production";
  const access = siteId ? await resolveSiteAccess(siteId, userId) : null;
  if (!access) {
    return NextResponse.json({ error: "App not found." }, { status: 404 });
  }

  const { db } = await import("@/lib/db");
  const latest = await db.operation.findFirst({
    where: {
      kind: SITE_DEPLOY_KIND,
      resourceType: "site",
      resourceId: access.site.id,
      input: { path: ["environment"], equals: environment },
      OR: [{ status: { in: ["queued", "running"] } }, { finishedAt: { gte: new Date(Date.now() - 10 * 60 * 1000) } }]
    },
    orderBy: { createdAt: "desc" }
  });
  return NextResponse.json({ operation: latest ? publicDeployView(latest) : null });
}
