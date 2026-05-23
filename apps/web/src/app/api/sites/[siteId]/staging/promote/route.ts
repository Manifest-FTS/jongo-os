import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { isAdminRole } from "@/lib/roles";
import {
  getCoolifyAppBackupInventory,
  getCoolifyAppStagingCapability,
  triggerCoolifyDeploy
} from "@/lib/coolify";
import { getBackupReadiness, getPathPreflight } from "@/lib/deploy-guards";
import { listSiteDeployments } from "@/lib/repositories";

type Params = { params: Promise<{ siteId: string }> };

type PromoteBody = {
  confirmationPhrase?: string;
};

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function buildSiteIdentityWhere(siteId: string) {
  if (isUuid(siteId)) {
    return {
      OR: [{ id: siteId }, { slug: siteId }],
      deletedAt: null
    };
  }

  return {
    slug: siteId,
    deletedAt: null
  };
}

async function recordStagingAuditLog(params: {
  organizationId: string;
  actorId: string;
  actionType: string;
  resourceId: string;
  details: Record<string, unknown>;
  req: Request;
}) {
  const { db } = await import("@/lib/db");
  await db.auditLog.create({
    data: {
      organizationId: params.organizationId,
      actorId: params.actorId,
      action: "site_updated",
      resourceType: "site_staging",
      resourceId: params.resourceId,
      details: {
        actionType: params.actionType,
        ...params.details
      },
      ipAddress: params.req.headers.get("x-forwarded-for") ?? params.req.headers.get("x-real-ip") ?? "unknown",
      userAgent: params.req.headers.get("user-agent") ?? undefined
    }
  });
}

export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { siteId } = await params;

  let body: PromoteBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.confirmationPhrase !== "PROMOTE") {
    return NextResponse.json({ error: "Confirmation phrase must be PROMOTE" }, { status: 400 });
  }

  const promoteAttemptId = crypto.randomUUID();

  const { db } = await import("@/lib/db");
  const site = await db.site.findFirst({
    where: {
      ...buildSiteIdentityWhere(siteId),
      organization: {
        deletedAt: null,
        OR: [{ ownerId: session.user.id }, { collaborators: { some: { userId: session.user.id } } }]
      }
    },
    include: {
      organization: {
        select: {
          id: true,
          ownerId: true,
          collaborators: { where: { userId: session.user.id }, select: { role: true } }
        }
      }
    }
  });

  if (!site) {
    return NextResponse.json({ error: "Not found or insufficient permissions" }, { status: 404 });
  }

  const callerIsOwner = site.organization.ownerId === session.user.id;
  const callerIsAdmin = callerIsOwner || isAdminRole(site.organization.collaborators[0]?.role);
  if (!callerIsAdmin) {
    return NextResponse.json({ error: "Only admins can promote staging to production" }, { status: 403 });
  }

  const appUuid = site.coolifyServiceUuid?.trim() || "";
  const projectId = site.coolifyProjectId?.trim() || undefined;
  if (!appUuid) {
    return NextResponse.json({ error: "Coolify service UUID is not linked." }, { status: 409 });
  }

  const viewer = {
    userId: session.user.id,
    email: session.user.email ?? undefined
  };

  const deployments = await listSiteDeployments(siteId, viewer);
  const inProgressProduction = deployments.find(
    (item) => item.environment === "production" && item.status === "in_progress"
  );
  if (inProgressProduction) {
    const blockingDeploymentId = inProgressProduction.coolifyDeploymentId ?? inProgressProduction.id;

    await recordStagingAuditLog({
      organizationId: site.organizationId,
      actorId: session.user.id,
      actionType: "staging_promote_blocked",
      resourceId: site.id,
      details: {
        promoteAttemptId,
        appUuid,
        blockingReason: "production_deployment_in_progress",
        blockingDeploymentId,
        blockingDeploymentStatus: inProgressProduction.status,
        blockingTriggeredAt: inProgressProduction.triggeredAt,
        message: `Promotion blocked because production deployment ${blockingDeploymentId} is already in progress.`
      },
      req
    });

    return NextResponse.json({
      error: "A production deployment is already in progress. Wait for completion before retrying promote.",
      promoteAttemptId,
      blockingDeployment: {
        id: blockingDeploymentId,
        status: inProgressProduction.status,
        triggeredAt: inProgressProduction.triggeredAt
      }
    }, { status: 409 });
  }

  const [stagingCapability, backupInventory] = await Promise.all([
    getCoolifyAppStagingCapability(appUuid, projectId),
    getCoolifyAppBackupInventory(appUuid)
  ]);

  const stagingConfigured = Boolean(site.stagingEnabled && stagingCapability.detected);
  const backupReadiness = getBackupReadiness(backupInventory, appUuid);
  const preflight = getPathPreflight("staging-to-production", backupReadiness, stagingConfigured);

  if (preflight.tone === "error") {
    await recordStagingAuditLog({
      organizationId: site.organizationId,
      actorId: session.user.id,
      actionType: "staging_promote_blocked",
      resourceId: site.id,
      details: {
        promoteAttemptId,
        appUuid,
        preflight,
        message: "Staging-to-production promote blocked by preflight checks."
      },
      req
    });

    return NextResponse.json({
      error: "Staging-to-production preflight is blocked.",
      promoteAttemptId,
      preflight
    }, { status: 409 });
  }

  try {
    const result = await triggerCoolifyDeploy(appUuid, "production");

    await recordStagingAuditLog({
      organizationId: site.organizationId,
      actorId: session.user.id,
      actionType: "staging_promote_triggered",
      resourceId: site.id,
      details: {
        promoteAttemptId,
        appUuid,
        deploymentId: result.deploymentId,
        mode: result.mode,
        preflight,
        message: result.message
      },
      req
    });

    return NextResponse.json({
      ok: true,
      promoteAttemptId,
      deploymentId: result.deploymentId,
      mode: result.mode,
      message: result.message,
      preflight
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to trigger production deploy.";

    await recordStagingAuditLog({
      organizationId: site.organizationId,
      actorId: session.user.id,
      actionType: "staging_promote_failed",
      resourceId: site.id,
      details: {
        promoteAttemptId,
        appUuid,
        preflight,
        message
      },
      req
    });

    return NextResponse.json({
      error: message,
      promoteAttemptId,
      preflight
    }, { status: 502 });
  }
}
