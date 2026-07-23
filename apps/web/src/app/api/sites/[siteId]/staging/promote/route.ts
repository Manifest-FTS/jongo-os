import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
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
  idempotencyKey?: string;
};

type BlockingReason =
  | "promote_cooldown"
  | "production_deployment_in_progress"
  | "staging_to_production_preflight_blocked";

type BlockingDeploymentPayload = {
  id: string;
  status: string;
  triggeredAt?: string;
};

const PROMOTE_BLOCK_COOLDOWN_MS = 30_000;
const IDEMPOTENCY_KEY_RE = /^[a-zA-Z0-9:_-]{8,128}$/;
const PROMOTE_SEMANTICS_NOTE = "Promote copies staging files/database into production, then triggers a production deployment.";

function normalizePublicUrl(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withProtocol).toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

async function runPromoteContentSync(params: {
  req: Request;
  siteId: string;
  productionServiceUuid: string;
  stagingServiceUuid: string;
  stagingUrl: string;
  productionUrl: string;
}) {
  const configuredAutomationUrl = (process.env.STAGING_SYNC_AUTOMATION_URL || "").trim();
  const automationUrl = configuredAutomationUrl || new URL("/api/ops/staging-sync-automation", params.req.url).toString();
  const token = (process.env.OWNERSHIP_SYNC_TOKEN || "").trim();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);

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
        siteId: params.siteId,
        productionServiceUuid: params.productionServiceUuid,
        stagingServiceUuid: params.stagingServiceUuid,
        stagingUrl: params.stagingUrl,
        productionUrl: params.productionUrl,
        direction: "staging-to-production",
        mode: "apply"
      })
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`Staging-to-production content sync failed (${response.status}): ${responseText.slice(0, 500)}`);
    }

    return responseText;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Staging-to-production content sync timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasOpsToken(req: Request): boolean {
  const configured = process.env.OWNERSHIP_SYNC_TOKEN?.trim() || "";
  const authHeader = req.headers.get("authorization") ?? "";
  const provided = authHeader.replace(/^Bearer\s+/i, "").trim();
  return Boolean(configured && provided && configured === provided);
}

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

function blockedPromoteResponse(params: {
  status: 409 | 429;
  error: string;
  promoteAttemptId: string;
  idempotencyKey?: string;
  blockingReason: BlockingReason;
  actionHint: string;
  retryAfterSeconds?: number;
  blockingDeployment?: BlockingDeploymentPayload;
  preflight?: Record<string, unknown>;
  previousBlockedAt?: string;
}) {
  return NextResponse.json({
    error: params.error,
    promoteAttemptId: params.promoteAttemptId,
    idempotencyKey: params.idempotencyKey,
    blockingReason: params.blockingReason,
    actionHint: params.actionHint,
    retryAfterSeconds: params.retryAfterSeconds,
    blockingDeployment: params.blockingDeployment,
    preflight: params.preflight,
    previousBlockedAt: params.previousBlockedAt
  }, { status: params.status });
}

async function recordStagingAuditLog(params: {
  organizationId: string;
  actorId?: string;
  actionType: string;
  resourceId: string;
  details: Record<string, unknown>;
  req: Request;
}) {
  const { db } = await import("@/lib/db");
  await db.auditLog.create({
    data: {
      organizationId: params.organizationId,
      actorId: params.actorId ?? null,
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

type RecentBlockedPromoteContext = {
  createdAt: Date;
  blockingReason?: string;
  blockingDeploymentId?: string;
  blockingTriggeredAt?: string;
};

type ReplayTriggeredPromoteContext = {
  promoteAttemptId?: string;
  deploymentId?: string;
  mode?: string;
  message?: string;
  preflight?: Record<string, unknown>;
};

function normalizeIdempotencyKey(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }

  return normalized;
}

async function readTriggeredReplayByIdempotencyKey(params: {
  organizationId: string;
  actorId?: string;
  resourceId: string;
  idempotencyKey: string;
}): Promise<ReplayTriggeredPromoteContext | null> {
  const { db } = await import("@/lib/db");
  const logs = await db.auditLog.findMany({
    where: {
      organizationId: params.organizationId,
      ...(params.actorId ? { actorId: params.actorId } : {}),
      action: "site_updated",
      resourceType: "site_staging",
      resourceId: params.resourceId
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      details: true
    }
  });

  for (const log of logs) {
    const details = (typeof log.details === "object" && log.details !== null
      ? log.details
      : null) as Record<string, unknown> | null;
    const actionType = typeof details?.actionType === "string" ? details.actionType : undefined;
    const loggedKey = typeof details?.idempotencyKey === "string" ? details.idempotencyKey : undefined;

    if (actionType !== "staging_promote_triggered" || loggedKey !== params.idempotencyKey) {
      continue;
    }

    return {
      promoteAttemptId: typeof details?.promoteAttemptId === "string" ? details.promoteAttemptId : undefined,
      deploymentId: typeof details?.deploymentId === "string" ? details.deploymentId : undefined,
      mode: typeof details?.mode === "string" ? details.mode : undefined,
      message: typeof details?.message === "string" ? details.message : undefined,
      preflight: (typeof details?.preflight === "object" && details.preflight !== null)
        ? (details.preflight as Record<string, unknown>)
        : undefined
    };
  }

  return null;
}

async function readRecentBlockedPromoteContext(params: {
  organizationId: string;
  actorId?: string;
  resourceId: string;
}): Promise<RecentBlockedPromoteContext | null> {
  const { db } = await import("@/lib/db");
  const logs = await db.auditLog.findMany({
    where: {
      organizationId: params.organizationId,
      ...(params.actorId ? { actorId: params.actorId } : {}),
      action: "site_updated",
      resourceType: "site_staging",
      resourceId: params.resourceId
    },
    orderBy: { createdAt: "desc" },
    take: 15,
    select: {
      createdAt: true,
      details: true
    }
  });

  for (const log of logs) {
    const details = (typeof log.details === "object" && log.details !== null
      ? log.details
      : null) as Record<string, unknown> | null;

    const actionType = typeof details?.actionType === "string" ? details.actionType : undefined;
    if (actionType !== "staging_promote_blocked") {
      continue;
    }

    return {
      createdAt: log.createdAt,
      blockingReason: typeof details?.blockingReason === "string" ? details.blockingReason : undefined,
      blockingDeploymentId: typeof details?.blockingDeploymentId === "string" ? details.blockingDeploymentId : undefined,
      blockingTriggeredAt: typeof details?.blockingTriggeredAt === "string" ? details.blockingTriggeredAt : undefined
    };
  }

  return null;
}

export async function POST(req: Request, { params }: Params) {
  const authorizedByToken = hasOpsToken(req);
  const session = await auth();
  if (!session?.user?.id && !authorizedByToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const actorId = session?.user?.id;

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

  const idempotencyKey = normalizeIdempotencyKey(body.idempotencyKey) ?? normalizeIdempotencyKey(req.headers.get("Idempotency-Key"));
  if (idempotencyKey && !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    return NextResponse.json({ error: "Invalid idempotency key format." }, { status: 400 });
  }

  const promoteAttemptId = crypto.randomUUID();

  const { db } = await import("@/lib/db");
  const site = await db.site.findFirst(
    authorizedByToken
      ? {
          where: {
            ...buildSiteIdentityWhere(siteId)
          },
          include: {
            organization: {
              select: {
                id: true,
                ownerId: true,
                collaborators: { select: { role: true }, take: 1 }
              }
            }
          }
        }
      : {
          where: {
            ...buildSiteIdentityWhere(siteId),
            OR: [
              {
                organization: {
                  deletedAt: null,
                  OR: [
                    { ownerId: session!.user!.id },
                    { collaborators: { some: { userId: session!.user!.id, deletedAt: null } } }
                  ]
                }
              },
              { collaborators: { some: { userId: session!.user!.id, deletedAt: null } } }
            ]
          },
          include: {
            organization: {
              select: {
                id: true,
                ownerId: true,
                collaborators: { where: { userId: session!.user!.id }, select: { role: true } }
              }
            }
          }
        }
  );

  if (!site) {
    return NextResponse.json({ error: "Not found or insufficient permissions" }, { status: 404 });
  }

  const appUuid = site.coolifyServiceUuid?.trim() || "";
  const projectId = site.coolifyProjectId?.trim() || undefined;
  if (!appUuid) {
    return NextResponse.json({ error: "Coolify service UUID is not linked." }, { status: 409 });
  }

  if (idempotencyKey) {
    const replay = await readTriggeredReplayByIdempotencyKey({
      organizationId: site.organizationId,
      actorId,
      resourceId: site.id,
      idempotencyKey
    });

    if (replay) {
      return NextResponse.json({
        ok: true,
        replayed: true,
        idempotencyKey,
        promoteAttemptId: replay.promoteAttemptId,
        deploymentId: replay.deploymentId,
        mode: replay.mode,
        message: `${replay.message ?? "Promotion already triggered for this idempotency key."} ${PROMOTE_SEMANTICS_NOTE}`,
        preflight: replay.preflight
      });
    }
  }

  const recentBlocked = await readRecentBlockedPromoteContext({
    organizationId: site.organizationId,
    actorId,
    resourceId: site.id
  });
  if (recentBlocked?.blockingReason === "production_deployment_in_progress") {
    const elapsed = Date.now() - recentBlocked.createdAt.getTime();
    if (elapsed < PROMOTE_BLOCK_COOLDOWN_MS) {
      const retryAfterSeconds = Math.ceil((PROMOTE_BLOCK_COOLDOWN_MS - elapsed) / 1000);

      await recordStagingAuditLog({
        organizationId: site.organizationId,
        actorId,
        actionType: "staging_promote_blocked",
        resourceId: site.id,
        details: {
          promoteAttemptId,
          idempotencyKey,
          appUuid,
          blockingReason: "promote_cooldown",
          retryAfterSeconds,
          previousBlockedAt: recentBlocked.createdAt.toISOString(),
          blockingDeploymentId: recentBlocked.blockingDeploymentId,
          blockingTriggeredAt: recentBlocked.blockingTriggeredAt,
          message: `Promotion temporarily rate-limited after repeated blocked attempts. Retry in ${retryAfterSeconds}s.`
        },
        req
      });

      return blockedPromoteResponse({
        status: 429,
        error: `Promotion temporarily rate-limited after repeated blocked attempts. Retry in ${retryAfterSeconds}s.`,
        promoteAttemptId,
        idempotencyKey,
        blockingReason: "promote_cooldown",
        actionHint: "Wait for the cooldown timer to expire, then retry promotion once.",
        retryAfterSeconds,
        previousBlockedAt: recentBlocked.createdAt.toISOString(),
        blockingDeployment: recentBlocked.blockingDeploymentId
          ? {
              id: recentBlocked.blockingDeploymentId,
              status: "in_progress",
              triggeredAt: recentBlocked.blockingTriggeredAt
            }
          : undefined
      });
    }
  }

  const viewer = session?.user?.id
    ? {
        userId: session.user.id,
        email: session.user.email ?? undefined
      }
    : undefined;

  const deployments = await listSiteDeployments(siteId, viewer);
  const inProgressProduction = deployments.find(
    (item) => item.environment === "production" && item.status === "in_progress"
  );
  if (inProgressProduction) {
    const blockingDeploymentId = inProgressProduction.coolifyDeploymentId ?? inProgressProduction.id;

    await recordStagingAuditLog({
      organizationId: site.organizationId,
      actorId,
      actionType: "staging_promote_blocked",
      resourceId: site.id,
      details: {
        promoteAttemptId,
        idempotencyKey,
        appUuid,
        blockingReason: "production_deployment_in_progress",
        blockingDeploymentId,
        blockingTriggeredAt: inProgressProduction.triggeredAt,
        message: `Promotion blocked because production deployment ${blockingDeploymentId} is already in progress.`
      },
      req
    });

    return blockedPromoteResponse({
      status: 409,
      error: "A production deployment is already in progress. Wait for completion before retrying promote.",
      promoteAttemptId,
      idempotencyKey,
      blockingReason: "production_deployment_in_progress",
      actionHint: "Wait for the current production deployment to finish, then refresh status and retry.",
      blockingDeployment: {
        id: blockingDeploymentId,
        status: inProgressProduction.status,
        triggeredAt: inProgressProduction.triggeredAt
      }
    });
  }

  const backupInventoryPromise = getCoolifyAppBackupInventory(appUuid);
  let stagingCapability = await getCoolifyAppStagingCapability(appUuid, projectId);

  // Coolify reads can intermittently fail even when staging exists.
  // Retry unresolved capability briefly before treating preflight as blocked.
  if (site.stagingEnabled && !stagingCapability.applicationUuid) {
    for (const retryDelayMs of [250, 500]) {
      await sleep(retryDelayMs);
      const retriedCapability = await getCoolifyAppStagingCapability(appUuid, projectId);
      stagingCapability = retriedCapability;
      if (retriedCapability.applicationUuid) {
        break;
      }
    }
  }

  const backupInventory = await backupInventoryPromise;

  const stagingConfigured = Boolean(site.stagingEnabled && stagingCapability.detected && stagingCapability.applicationUuid);
  const backupReadiness = getBackupReadiness(backupInventory, appUuid);
  const preflight = getPathPreflight("staging-to-production", backupReadiness, stagingConfigured);
  const stagingUrl = normalizePublicUrl(stagingCapability.stagingUrl ?? stagingCapability.fqdn);
  const productionUrl = normalizePublicUrl(site.name) ?? normalizePublicUrl(site.slug);

  if (preflight.tone === "error") {
    await recordStagingAuditLog({
      organizationId: site.organizationId,
      actorId,
      actionType: "staging_promote_blocked",
      resourceId: site.id,
      details: {
        promoteAttemptId,
        idempotencyKey,
        appUuid,
        preflight,
        message: "Staging-to-production promote blocked by preflight checks."
      },
      req
    });

    return blockedPromoteResponse({
      status: 409,
      error: "Staging-to-production preflight is blocked.",
      promoteAttemptId,
      idempotencyKey,
      blockingReason: "staging_to_production_preflight_blocked",
      actionHint: "Resolve preflight blockers shown in staging readiness, then retry promotion.",
      preflight
    });
  }

  if (!stagingUrl || !productionUrl || !stagingCapability.applicationUuid) {
    const message = "Staging-to-production sync requires both staging and production URLs plus an attached staging target.";

    await recordStagingAuditLog({
      organizationId: site.organizationId,
      actorId,
      actionType: "staging_promote_failed",
      resourceId: site.id,
      details: {
        promoteAttemptId,
        idempotencyKey,
        appUuid,
        preflight,
        message
      },
      req
    });

    return NextResponse.json({
      error: message,
      promoteAttemptId,
      idempotencyKey,
      preflight
    }, { status: 409 });
  }

  try {
    await runPromoteContentSync({
      req,
      siteId,
      productionServiceUuid: appUuid,
      stagingServiceUuid: stagingCapability.applicationUuid,
      stagingUrl,
      productionUrl
    });

    const result = await triggerCoolifyDeploy(appUuid, "production");

    await recordStagingAuditLog({
      organizationId: site.organizationId,
      actorId,
      actionType: "staging_promote_triggered",
      resourceId: site.id,
      details: {
        promoteAttemptId,
        idempotencyKey,
        appUuid,
        deploymentId: result.deploymentId,
        mode: result.mode,
        preflight,
        message: `${result.message} ${PROMOTE_SEMANTICS_NOTE}`
      },
      req
    });

    return NextResponse.json({
      ok: true,
      promoteAttemptId,
      idempotencyKey,
      deploymentId: result.deploymentId,
      mode: result.mode,
      message: `${result.message} ${PROMOTE_SEMANTICS_NOTE}`,
      preflight
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to trigger production deploy.";

    await recordStagingAuditLog({
      organizationId: site.organizationId,
      actorId,
      actionType: "staging_promote_failed",
      resourceId: site.id,
      details: {
        promoteAttemptId,
        idempotencyKey,
        appUuid,
        preflight,
        message
      },
      req
    });

    return NextResponse.json({
      error: message,
      promoteAttemptId,
      idempotencyKey,
      preflight
    }, { status: 502 });
  }
}
