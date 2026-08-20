import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { buildSiteIdentityWhere } from "@/lib/site-identity";
import {
  getCoolifyAppBackupInventory,
  getCoolifyAppStagingCapability,
  triggerCoolifyDeploy
} from "@/lib/coolify";
import { getBackupReadiness, getPathPreflight, shouldAutoBackupBeforePromote } from "@/lib/deploy-guards";
import { listSiteDeployments } from "@/lib/repositories";
import { startSiteBackup } from "@/lib/site-backup-start";
import { runUrlRewrite } from "@/lib/wp-url-rewrite-run";
import { summarizeRewriteReport } from "@/lib/wp-url-rewrite";

// Promote spawns the first-run backup as a detached child process.
export const runtime = "nodejs";

type Params = { params: Promise<{ siteId: string }> };

type PromoteBody = {
  confirmationPhrase?: string;
  idempotencyKey?: string;
};

type BlockingReason =
  | "promote_cooldown"
  | "production_deployment_in_progress"
  | "staging_to_production_preflight_blocked"
  | "promote_backup_started"
  | "promote_backup_in_progress";

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
  backupId?: string;
  backupStarted?: boolean;
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
    previousBlockedAt: params.previousBlockedAt,
    backupId: params.backupId,
    backupStarted: params.backupStarted
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

  // Promote REPLACES production with the staging copy. This route checked only
  // that someone was signed in, so any collaborator could overwrite a live site.
  // The ops-token path is exempt: it is automation, with no user to check.
  if (!authorizedByToken && actorId) {
    const { getSiteWorkspace } = await import("@/lib/repositories");
    const { resolveSitePermissionSnapshot } = await import("@/lib/permissions");
    const workspace = await getSiteWorkspace(siteId, { userId: actorId, email: session?.user?.email });
    if (!workspace) {
      return NextResponse.json({ error: "Not found or insufficient permissions" }, { status: 404 });
    }
    const permissions = await resolveSitePermissionSnapshot({
      siteId,
      workspace,
      viewer: { userId: actorId, email: session?.user?.email }
    });
    if (!permissions.canPromoteStaging) {
      return NextResponse.json(
        { error: "Only organisation admins can promote staging to production." },
        { status: 403 }
      );
    }
  }

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
  let stagingCapability = await getCoolifyAppStagingCapability(appUuid, projectId, /* Relaxed: the staging route CREATES under this rule and the pages DISPLAY under it. Strict here made promote disagree with a UI that said 'Target Attached', blocking on 'Staging is not configured'. */ { relaxedTargetMatch: true });

  // Coolify reads can intermittently fail even when staging exists.
  // Retry unresolved capability briefly before treating preflight as blocked.
  if (site.stagingEnabled && !stagingCapability.applicationUuid) {
    for (const retryDelayMs of [250, 500]) {
      await sleep(retryDelayMs);
      const retriedCapability = await getCoolifyAppStagingCapability(appUuid, projectId, /* Relaxed: the staging route CREATES under this rule and the pages DISPLAY under it. Strict here made promote disagree with a UI that said 'Target Attached', blocking on 'Staging is not configured'. */ { relaxedTargetMatch: true });
      stagingCapability = retriedCapability;
      if (retriedCapability.applicationUuid) {
        break;
      }
    }
  }

  const backupInventory = await backupInventoryPromise;

  const stagingConfigured = Boolean(site.stagingEnabled && stagingCapability.detected && stagingCapability.applicationUuid);
  // Jongo's own backup history: the restic snapshots that are the actual
  // protection for a WordPress stack, which Coolify's telemetry cannot see.
  const jongoBackupState = await (async () => {
    try {
      const { getDb } = await import("@/lib/db");
      const prisma = await getDb();
      if (!prisma || !("siteBackup" in prisma)) return null;
      const last = await (prisma as any).siteBackup.findFirst({
        where: { siteId: site.id, status: "success" },
        orderBy: { completedAt: "desc" },
        select: { completedAt: true }
      });
      return { lastSuccessAt: last?.completedAt ?? null };
    } catch {
      // Unknown is not "never": fall back to the Coolify rule rather than
      // locking on a database hiccup.
      return null;
    }
  })();

  const backupReadiness = getBackupReadiness(backupInventory, appUuid, jongoBackupState);
  const preflight = getPathPreflight("staging-to-production", backupReadiness, stagingConfigured);
  const stagingUrl = normalizePublicUrl(stagingCapability.stagingUrl ?? stagingCapability.fqdn);
  const productionUrl = normalizePublicUrl(site.name) ?? normalizePublicUrl(site.slug);

  // Never backed up, but otherwise ready to promote: take the backup instead of
  // sending the operator to another tab to press a different button. The guard
  // exists so a bad promote can be undone, and the only thing standing between
  // this site and that is one backup nobody has run yet.
  //
  // The backup does NOT block this request. It runs detached and can take many
  // minutes for a large site, and Cloudflare cuts the connection at ~100s — so
  // waiting for it here would turn a working promote into a 502. Promote is
  // therefore declined once, with the backup already running, and succeeds on
  // the retry. Not resuming automatically is also the safer reading: promote
  // overwrites production behind a typed confirmation, and that confirmation
  // should not carry across an unattended gap of unknown length.
  if (
    shouldAutoBackupBeforePromote({
      preflightTone: preflight.tone,
      stagingConfigured,
      backupCode: backupReadiness.code
    })
  ) {
    const started = await startSiteBackup({
      site: {
        id: site.id,
        slug: site.slug,
        name: site.name,
        coolifyServiceUuid: site.coolifyServiceUuid
      },
      trigger: "promote",
      label: "Pre-promotion backup (first backup for this app)"
    });

    // A backup already in flight is the same waiting game, not a new problem —
    // and starting a second one over it is exactly what the concurrency guard
    // in startSiteBackup exists to prevent.
    const backupInFlight = started.ok || started.reason === "already_running";

    if (backupInFlight) {
      const backupId = started.ok ? started.backupId : started.runningBackupId;
      const error = started.ok
        ? "This app had never been backed up, so a backup was started first. Promotion will be available once it completes."
        : "A backup is already running for this app. Promotion will be available once it completes.";

      await recordStagingAuditLog({
        organizationId: site.organizationId,
        actorId,
        actionType: "staging_promote_backup_started",
        resourceId: site.id,
        details: {
          promoteAttemptId,
          idempotencyKey,
          appUuid,
          preflight,
          backupId,
          backupStarted: started.ok,
          message: error
        },
        req
      });

      return blockedPromoteResponse({
        status: 409,
        error,
        promoteAttemptId,
        // idempotencyKey is left off the payload because no promote was
        // triggered under it and echoing it invites the client to treat it as
        // settled. Retrying with the same key is safe either way: the replay
        // cache only matches `staging_promote_triggered` audit entries, and this
        // attempt is logged as `staging_promote_backup_started`.
        blockingReason: started.ok ? "promote_backup_started" : "promote_backup_in_progress",
        actionHint: "Wait for the backup to finish in the Backups tab, then promote again.",
        preflight,
        backupId,
        backupStarted: started.ok
      });
    }

    // The backup could not be started at all (no SSH host, nothing backupable,
    // records unavailable). Fall through to the normal blocked response, but say
    // why the automatic attempt failed rather than repeating "take a backup".
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
        backupStartFailureReason: started.reason,
        message: `Staging-to-production promote blocked: this app has never been backed up and the automatic backup could not be started (${started.reason}).`
      },
      req
    });

    return blockedPromoteResponse({
      status: 409,
      error: `This app has never been backed up, and the automatic backup could not be started: ${started.message}`,
      promoteAttemptId,
      idempotencyKey,
      blockingReason: "staging_to_production_preflight_blocked",
      actionHint: "Resolve the backup problem, take a backup, then retry promotion.",
      preflight
    });
  }

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

    // The content sync copies staging's database wholesale, which brings
    // staging's URLs with it — and it only ever rewrote wp_options siteurl/home.
    // Every absolute URL inside post content, page-builder JSON and serialized
    // widget options still named the staging host, so a promoted site served
    // stage.* asset URLs from production. Rewrite them before the deploy, so the
    // site that comes up is already self-consistent.
    let urlRewrite: Awaited<ReturnType<typeof runUrlRewrite>> | null = null;
    try {
      urlRewrite = await runUrlRewrite({
        resourceUuid: appUuid,
        fromUrl: stagingUrl,
        toUrl: productionUrl,
        apply: true
      });
      if (!urlRewrite.ok) {
        console.error(
          `[jongo] promote ${promoteAttemptId}: URL rewrite failed for ${appUuid}: ${urlRewrite.error}`
        );
      }
    } catch (error) {
      // Not fatal: the content is already in production and a deploy still needs
      // to happen. The outcome is reported so nobody assumes the URLs are clean.
      console.error(`[jongo] promote ${promoteAttemptId}: URL rewrite threw`, error);
    }

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
        urlRewrite: urlRewrite
          ? { ok: urlRewrite.ok, rowsChanged: urlRewrite.rowsChanged, skipped: urlRewrite.skippedUnserializable, error: urlRewrite.error }
          : null,
        message: `${result.message} ${PROMOTE_SEMANTICS_NOTE}`
      },
      req
    });

    // The promote is done and audited; a notification failure must not turn a
    // successful promotion into an error response.
    try {
      const { notifyBackupEvent } = await import("@/lib/site-notify");
      await notifyBackupEvent({
        siteId: site.id,
        event: "staging_synced_to_production",
        stagingUrl,
        productionUrl,
        urlRowsRewritten: urlRewrite?.ok ? urlRewrite.rowsChanged : null,
        deploymentId: result.deploymentId ?? null,
        actorEmail: session?.user?.email ?? null
      });
    } catch (error) {
      console.error(`[jongo] promote ${promoteAttemptId}: notification failed`, error);
    }

    return NextResponse.json({
      ok: true,
      promoteAttemptId,
      idempotencyKey,
      deploymentId: result.deploymentId,
      mode: result.mode,
      message: `${result.message} ${PROMOTE_SEMANTICS_NOTE}`,
      preflight,
      // Surfaced, not swallowed: a promote whose URL rewrite failed leaves
      // production serving staging asset URLs, and that must not read as a clean
      // success.
      urlRewrite: urlRewrite
        ? { ok: urlRewrite.ok, rowsChanged: urlRewrite.rowsChanged, skippedUnserializable: urlRewrite.skippedUnserializable, summary: summarizeRewriteReport(urlRewrite) }
        : null
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
