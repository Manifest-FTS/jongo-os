import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getSiteWorkspace, listSiteDeployments } from "@/lib/repositories";

type Params = { params: Promise<{ siteId: string }> };

function normalizeLimit(raw: string | null): number {
  const parsed = Number(raw ?? 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 10;
  }

  return Math.min(Math.floor(parsed), 50);
}

type PromoteLifecycleAction =
  | "staging_promote_in_progress"
  | "staging_promote_succeeded"
  | "staging_promote_failed";

type AuditActionEntry = {
  actorId: string;
  entryActionType?: string;
  entryDeploymentId?: string;
  entryPromoteAttemptId?: string;
};

function mapDeployStatusToPromoteLifecycleAction(status: string): PromoteLifecycleAction | null {
  if (status === "in_progress") {
    return "staging_promote_in_progress";
  }

  if (status === "success" || status === "healthy") {
    return "staging_promote_succeeded";
  }

  if (status === "failed" || status === "error") {
    return "staging_promote_failed";
  }

  return null;
}

function actionMessage(actionType: PromoteLifecycleAction, deploymentId: string): string {
  if (actionType === "staging_promote_in_progress") {
    return `Production deployment ${deploymentId} is in progress.`;
  }

  if (actionType === "staging_promote_succeeded") {
    return `Production deployment ${deploymentId} completed successfully.`;
  }

  return `Production deployment ${deploymentId} failed.`;
}

async function recordPromoteLifecycleAudit(params: {
  siteDbId: string;
  organizationId: string;
  fallbackActorId: string;
  deploymentId: string;
  status: string;
  triggeredAt?: string;
  finishedAt?: string;
  generatedAt: string;
}) {
  const actionType = mapDeployStatusToPromoteLifecycleAction(params.status);
  if (!actionType) {
    return;
  }

  const { db } = await import("@/lib/db");
  const recentLogs = await db.auditLog.findMany({
    where: {
      organizationId: params.organizationId,
      resourceType: "site_staging",
      resourceId: params.siteDbId,
      action: "site_updated"
    },
    orderBy: { createdAt: "desc" },
    take: 100
  });

  const withActionType: AuditActionEntry[] = recentLogs.map((entry: { details: unknown; actorId: string }) => {
    const details = (typeof entry.details === "object" && entry.details !== null
      ? entry.details
      : null) as Record<string, unknown> | null;
    const entryActionType = typeof details?.actionType === "string" ? details.actionType : undefined;
    const entryDeploymentId = typeof details?.deploymentId === "string" ? details.deploymentId : undefined;
    const entryPromoteAttemptId = typeof details?.promoteAttemptId === "string" ? details.promoteAttemptId : undefined;

    return {
      actorId: entry.actorId,
      entryActionType,
      entryDeploymentId,
      entryPromoteAttemptId
    };
  });

  const triggerForDeployment = withActionType.find(
    (entry: AuditActionEntry) =>
      entry.entryActionType === "staging_promote_triggered" && entry.entryDeploymentId === params.deploymentId
  );

  if (!triggerForDeployment) {
    return;
  }

  const promoteAttemptId = triggerForDeployment.entryPromoteAttemptId ?? params.deploymentId;

  const alreadyRecorded = withActionType.some(
    (entry: AuditActionEntry) =>
      entry.entryActionType === actionType && (
        entry.entryPromoteAttemptId === promoteAttemptId ||
        entry.entryDeploymentId === params.deploymentId
      )
  );
  if (alreadyRecorded) {
    return;
  }

  await db.auditLog.create({
    data: {
      organizationId: params.organizationId,
      actorId: triggerForDeployment.actorId ?? params.fallbackActorId,
      action: "site_updated",
      resourceType: "site_staging",
      resourceId: params.siteDbId,
      details: {
        actionType,
        promoteAttemptId,
        deploymentId: params.deploymentId,
        deploymentStatus: params.status,
        triggeredAt: params.triggeredAt,
        finishedAt: params.finishedAt,
        message: actionMessage(actionType, params.deploymentId),
        generatedAt: params.generatedAt
      },
      ipAddress: "system",
      userAgent: "deployments-poll-reconcile"
    }
  });
}

export async function GET(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { siteId } = await params;
  const url = new URL(req.url);
  const limit = normalizeLimit(url.searchParams.get("limit"));

  const viewer = {
    userId: session.user.id,
    email: session.user.email ?? undefined
  };

  const workspace = await getSiteWorkspace(siteId, viewer);
  if (!workspace) {
    return NextResponse.json({ error: "Not found or insufficient permissions" }, { status: 404 });
  }

  const deployments = (await listSiteDeployments(siteId, viewer)).slice(0, limit);
  const latestProduction = deployments.find((item) => item.environment === "production") ?? null;
  const inProgressProduction = deployments.find(
    (item) => item.environment === "production" && item.status === "in_progress"
  ) ?? null;
  const generatedAt = new Date().toISOString();

  if (latestProduction && workspace.organizationId) {
    const deploymentId = latestProduction.coolifyDeploymentId ?? latestProduction.id;
    if (deploymentId) {
      await recordPromoteLifecycleAudit({
        siteDbId: workspace.id,
        organizationId: workspace.organizationId,
        fallbackActorId: session.user.id,
        deploymentId,
        status: latestProduction.status,
        triggeredAt: latestProduction.triggeredAt,
        finishedAt: latestProduction.finishedAt,
        generatedAt
      });
    }
  }

  return NextResponse.json({
    ok: true,
    generatedAt,
    deployments,
    latestProduction,
    inProgressProduction
  });
}
