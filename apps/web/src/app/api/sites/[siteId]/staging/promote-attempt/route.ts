import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getSiteWorkspace, listSiteDeployments } from "@/lib/repositories";

type Params = { params: Promise<{ siteId: string }> };

function hasOpsToken(req: Request): boolean {
  const configured = process.env.OWNERSHIP_SYNC_TOKEN?.trim() || "";
  const authHeader = req.headers.get("authorization") ?? "";
  const provided = authHeader.replace(/^Bearer\s+/i, "").trim();
  return Boolean(configured && provided && configured === provided);
}

type PromoteAttemptActionType =
  | "staging_promote_blocked"
  | "staging_promote_triggered"
  | "staging_promote_in_progress"
  | "staging_promote_succeeded"
  | "staging_promote_failed";

type PromoteAttemptStatus = "blocked" | "triggered" | "in_progress" | "succeeded" | "failed";

type AttemptEvent = {
  id: string;
  createdAt: string;
  actionType: PromoteAttemptActionType;
  message: string;
  deploymentId?: string;
  deploymentStatus?: string;
  blockingReason?: string;
};

function normalizeAttemptId(value: string | null): string {
  return value?.trim() ?? "";
}

function isPromoteActionType(value: string): value is PromoteAttemptActionType {
  return (
    value === "staging_promote_blocked" ||
    value === "staging_promote_triggered" ||
    value === "staging_promote_in_progress" ||
    value === "staging_promote_succeeded" ||
    value === "staging_promote_failed"
  );
}

function mapAttemptStatus(actionType: PromoteAttemptActionType): PromoteAttemptStatus {
  if (actionType === "staging_promote_blocked") {
    return "blocked";
  }

  if (actionType === "staging_promote_failed") {
    return "failed";
  }

  if (actionType === "staging_promote_succeeded") {
    return "succeeded";
  }

  if (actionType === "staging_promote_in_progress") {
    return "in_progress";
  }

  return "triggered";
}

function statusLabel(status: PromoteAttemptStatus): string {
  if (status === "blocked") {
    return "Blocked";
  }

  if (status === "failed") {
    return "Failed";
  }

  if (status === "succeeded") {
    return "Succeeded";
  }

  if (status === "in_progress") {
    return "In progress";
  }

  return "Triggered";
}

function statusTone(status: PromoteAttemptStatus): "healthy" | "degraded" | "error" | "unknown" {
  if (status === "succeeded") {
    return "healthy";
  }

  if (status === "failed" || status === "blocked") {
    return "error";
  }

  if (status === "in_progress" || status === "triggered") {
    return "degraded";
  }

  return "unknown";
}

export async function GET(req: Request, { params }: Params) {
  const authorizedByToken = hasOpsToken(req);
  const session = await auth();
  if (!session?.user?.id && !authorizedByToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { siteId } = await params;
  const url = new URL(req.url);
  const attemptId = normalizeAttemptId(url.searchParams.get("attemptId"));
  if (!attemptId) {
    return NextResponse.json({ error: "Query param attemptId is required." }, { status: 400 });
  }

  const viewer = session?.user?.id
    ? {
        userId: session.user.id,
        email: session.user.email ?? undefined
      }
    : undefined;

  const workspace = await getSiteWorkspace(siteId, viewer);
  if (!workspace || !workspace.organizationId) {
    return NextResponse.json({ error: "Not found or insufficient permissions" }, { status: 404 });
  }

  const { db } = await import("@/lib/db");
  const logs = await db.auditLog.findMany({
    where: {
      organizationId: workspace.organizationId,
      resourceType: "site_staging",
      resourceId: workspace.id,
      action: "site_updated"
    },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      createdAt: true,
      details: true
    }
  });

  const events: AttemptEvent[] = [];

  for (const log of logs) {
    const details = (typeof log.details === "object" && log.details !== null
      ? log.details
      : null) as Record<string, unknown> | null;

    const actionTypeRaw = typeof details?.actionType === "string" ? details.actionType : undefined;
    const promoteAttemptId = typeof details?.promoteAttemptId === "string" ? details.promoteAttemptId : undefined;

    if (!actionTypeRaw || !isPromoteActionType(actionTypeRaw) || promoteAttemptId !== attemptId) {
      continue;
    }

    events.push({
      id: log.id,
      createdAt: log.createdAt.toISOString(),
      actionType: actionTypeRaw,
      message: typeof details?.message === "string" ? details.message : "Promotion event recorded.",
      deploymentId: typeof details?.deploymentId === "string" ? details.deploymentId : undefined,
      deploymentStatus: typeof details?.deploymentStatus === "string" ? details.deploymentStatus : undefined,
      blockingReason: typeof details?.blockingReason === "string" ? details.blockingReason : undefined
    });
  }

  if (events.length === 0) {
    return NextResponse.json({ error: "No promotion attempt found for attemptId.", attemptId }, { status: 404 });
  }

  const latestEvent = events[0];
  let status = mapAttemptStatus(latestEvent.actionType);
  let deploymentId = latestEvent.deploymentId;
  let deploymentStatus = latestEvent.deploymentStatus;
  let triggeredAt: string | undefined;
  let finishedAt: string | undefined;

  if (deploymentId) {
    const deployments = await listSiteDeployments(siteId, viewer);
    const matchingDeployment = deployments.find(
      (deployment) =>
        (deployment.coolifyDeploymentId && deployment.coolifyDeploymentId === deploymentId) ||
        deployment.id === deploymentId
    );

    if (matchingDeployment) {
      deploymentStatus = matchingDeployment.status;
      triggeredAt = matchingDeployment.triggeredAt;
      finishedAt = matchingDeployment.finishedAt;

      if (matchingDeployment.status === "success" || matchingDeployment.status === "healthy") {
        status = "succeeded";
      } else if (matchingDeployment.status === "failed" || matchingDeployment.status === "error") {
        status = "failed";
      } else if (matchingDeployment.status === "in_progress") {
        status = "in_progress";
      }
    }
  }

  return NextResponse.json({
    ok: true,
    attemptId,
    status,
    statusLabel: statusLabel(status),
    statusTone: statusTone(status),
    message: latestEvent.message,
    deploymentId,
    deploymentStatus,
    blockingReason: latestEvent.blockingReason,
    triggeredAt,
    finishedAt,
    updatedAt: latestEvent.createdAt,
    events
  });
}
