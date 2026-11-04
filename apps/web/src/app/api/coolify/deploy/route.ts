import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { triggerCoolifyDeploy } from "@/lib/coolify";
import { getPermissions } from "@/lib/permissions";
import { resolveSiteAccess } from "@/lib/tenant-route-access";

export const runtime = "nodejs";

/**
 * Redeploy an app the caller has access to.
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

  let result;
  try {
    result = await triggerCoolifyDeploy(targetUuid, environment);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Deploy trigger failed";
    console.error("[deploy] trigger failed", { siteId: site.id, environment, message });
    return NextResponse.json({ error: "The deploy couldn't be started. Try again shortly." }, { status: 502 });
  }

  // Recording is best-effort: the deploy has already started and must not be
  // reported as failed because a history row could not be written.
  try {
    // Only a real deploy gets a history row. A restart (WordPress service) has
    // no Coolify deployment to track, and its id is a placeholder that would
    // sit "in progress" forever.
    if (result.action === "deploy") {
      const env = await db.environment.upsert({
        where: { siteId_name: { siteId: site.id, name: environment } },
        update: {},
        create: { siteId: site.id, name: environment, isProductionLike: environment === "production" },
        select: { id: true }
      });

      await db.deployment.create({
        data: {
          environmentId: env.id,
          coolifyDeploymentId: result.deploymentId,
          status: "in_progress",
          triggeredAt: new Date(),
          triggeredById: userId
        }
      });
    }

    await db.auditLog.create({
      data: {
        organizationId: site.organizationId,
        actorId: userId,
        action: "deploy_triggered",
        resourceType: "site",
        resourceId: site.id,
        details: { environment, action: result.action ?? "deploy", deploymentId: result.deploymentId ?? null },
        ipAddress: req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip") ?? null,
        userAgent: req.headers.get("user-agent") ?? null
      }
    });
  } catch (error) {
    console.error("[deploy] could not record deployment", { siteId: site.id, error });
  }

  return NextResponse.json({ deploymentId: result.deploymentId, action: result.action, message: result.message });
}
