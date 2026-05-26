import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { isAdminRole } from "@/lib/roles";
import {
  applyCoolifyApplicationDomain,
  applyCoolifyApplicationDomains,
  applyCoolifyServiceDomains,
  buildStagingSyncDryRunPlan,
  deleteCoolifyStagingEnvironment,
  deriveCoolifyStagingDomainFromProduction,
  getCoolifyAppBackupInventory,
  destroyCoolifyApplication,
  getCoolifyAppStagingCapability,
  provisionCoolifyStagingFromProduction
} from "@/lib/coolify";
import { getBackupReadiness, getPathPreflight } from "@/lib/deploy-guards";

type Params = { params: Promise<{ siteId: string }> };

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

function stagingTargetLabel(resourceKind?: string): "application" | "service" {
  return resourceKind === "service" ? "service" : "application";
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

export async function GET(_req: Request, { params }: Params) {
  const authorizedByToken = hasOpsToken(_req);
  const session = await auth();
  if (!session?.user?.id && !authorizedByToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { siteId } = await params;
  const { db } = await import("@/lib/db");

  const site = await db.site.findFirst({
    where: authorizedByToken
      ? {
          ...buildSiteIdentityWhere(siteId)
        }
      : {
          ...buildSiteIdentityWhere(siteId),
          organization: {
            deletedAt: null,
            OR: [{ ownerId: session!.user!.id }, { collaborators: { some: { userId: session!.user!.id } } }]
          }
        },
    select: {
      id: true,
      slug: true,
      name: true,
      stagingEnabled: true,
      coolifyServiceUuid: true,
      coolifyProjectId: true
    }
  });

  if (!site) {
    return NextResponse.json({ error: "Not found or insufficient permissions" }, { status: 404 });
  }

  const appUuid = site.coolifyServiceUuid?.trim() || "";
  const projectId = site.coolifyProjectId?.trim() || undefined;

  const [stagingCapability, backupInventory] = appUuid
    ? await Promise.all([
        getCoolifyAppStagingCapability(appUuid, projectId),
        getCoolifyAppBackupInventory(appUuid)
      ])
    : [null, null];

  const stagingConfigured = Boolean(site.stagingEnabled && stagingCapability?.detected && stagingCapability?.applicationUuid);
  const backupReadiness = getBackupReadiness(backupInventory, appUuid || undefined);
  const productionToStaging = getPathPreflight("production-to-staging", backupReadiness, stagingConfigured);
  const stagingToProduction = getPathPreflight("staging-to-production", backupReadiness, stagingConfigured);
  const coolifyTelemetryUnavailable = Boolean(
    appUuid && (
      stagingCapability?.note === "fetch_error" ||
      backupInventory?.note === "fetch_error" ||
      backupInventory?.note === "backup_telemetry_unavailable"
    )
  );

  const dryRunPlan =
    stagingConfigured && appUuid && stagingCapability
      ? await buildStagingSyncDryRunPlan(appUuid, site.name ?? site.slug ?? site.id, stagingCapability)
      : null;

  const readyForSyncTesting = Boolean(
    stagingConfigured &&
    !backupReadiness.locked &&
    dryRunPlan?.target
  );

  const blockers: string[] = [];
  if (!site.stagingEnabled) {
    blockers.push("Staging is disabled in Jongo for this app.");
  }
  if (!appUuid) {
    blockers.push("Coolify service UUID is not linked.");
  }
  if (site.stagingEnabled && appUuid && coolifyTelemetryUnavailable) {
    blockers.push("Coolify API telemetry unavailable (likely auth/scope or network restriction). Staging detection may be incomplete.");
  } else if (!stagingCapability?.detected) {
    blockers.push("No staging environment/application is currently detected in Coolify.");
  }
  if (site.stagingEnabled && stagingCapability?.detected && !stagingCapability?.applicationUuid) {
    blockers.push(`Staging environment exists but no staging ${stagingTargetLabel(stagingCapability?.resourceKind)} target is attached yet.`);
  }
  if (backupReadiness.locked) {
    blockers.push(backupReadiness.reason ?? "Backup readiness is not satisfied.");
  }
  if (stagingConfigured && dryRunPlan && !dryRunPlan.target) {
    blockers.push("Dry-run sync plan could not resolve a staging target.");
  }

  const suggestedActions: string[] = [];
  if (!site.stagingEnabled) {
    suggestedActions.push("Enable staging in app settings. Jongo will attempt staging provisioning in Coolify automatically.");
  }
  if (site.stagingEnabled && appUuid && coolifyTelemetryUnavailable) {
    suggestedActions.push("Verify COOLIFY_API_TOKEN scope, COOLIFY_API_BASE_URL reachability, and any Coolify allowlist/edge restrictions; then re-run staging preflight.");
  } else if (site.stagingEnabled && appUuid && !stagingCapability?.detected) {
    suggestedActions.push("Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.");
  }
  if (site.stagingEnabled && stagingCapability?.detected && !stagingCapability?.applicationUuid) {
    const targetLabel = stagingTargetLabel(stagingCapability?.resourceKind);
    suggestedActions.push(`Provision or attach a staging ${targetLabel} in Coolify so sync and promote checks can target a concrete staging ${targetLabel}.`);
  }
  if (!appUuid) {
    suggestedActions.push("Link a Coolify Service UUID in app settings so staging detection and provisioning can run.");
  }
  if (backupReadiness.locked) {
    suggestedActions.push(backupReadiness.nextStep ?? "Fix backup readiness blockers before sync testing.");
  }
  if (readyForSyncTesting) {
    suggestedActions.push("Run dry-run preflight checks and validate staging content before any manual promote/sync action in Coolify.");
  }

  return NextResponse.json({
    site: {
      id: site.id,
      slug: site.slug,
      name: site.name,
      coolifyServiceUuid: site.coolifyServiceUuid,
      coolifyProjectId: site.coolifyProjectId
    },
    generatedAt: new Date().toISOString(),
    stagingEnabled: site.stagingEnabled,
    stagingConfigured,
    readyForSyncTesting,
    blockers,
    suggestedActions,
    backupReadiness,
    preflight: {
      productionToStaging,
      stagingToProduction
    },
    stagingCapability,
    dryRunPlan
  });
}

export async function POST(req: Request, { params }: Params) {
  const authorizedByToken = hasOpsToken(req);
  const session = await auth();
  if (!session?.user?.id && !authorizedByToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const actorId = session?.user?.id;

  const { siteId } = await params;

  let body: { enabled?: boolean; burnExisting?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "'enabled' must be boolean" }, { status: 400 });
  }

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
            organization: {
              deletedAt: null,
              OR: [{ ownerId: session!.user!.id }, { collaborators: { some: { userId: session!.user!.id } } }]
            }
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

  const callerIsOwner = Boolean(session?.user?.id && site.organization.ownerId === session.user.id);
  const callerIsAdmin = authorizedByToken || callerIsOwner || isAdminRole(site.organization.collaborators[0]?.role);
  if (!callerIsAdmin) {
    return NextResponse.json({ error: "Only admins can manage staging" }, { status: 403 });
  }

  const appUuid = site.coolifyServiceUuid?.trim() || "";
  const projectId = site.coolifyProjectId?.trim() || undefined;

  if (body.enabled) {
    await db.site.update({
      where: { id: site.id },
      data: { stagingEnabled: true }
    });

    const enableAuditDetails: Record<string, unknown> = {
      enabled: true,
      appUuid: appUuid || null
    };

    if (!appUuid) {
      await recordStagingAuditLog({
        organizationId: site.organizationId,
        actorId,
        actionType: "staging_enable_requested",
        resourceId: site.id,
        details: enableAuditDetails,
        req
      });

      return NextResponse.json({
        enabled: true,
        stagedDetected: false,
        message: "Staging enabled in Jongo. Link a Coolify Service UUID to provision or detect staging."
      });
    }

    const currentCapability = await getCoolifyAppStagingCapability(appUuid, projectId);
    const currentStagingTargetResolved = Boolean(currentCapability.detected && currentCapability.applicationUuid);
    if (currentStagingTargetResolved) {
      await recordStagingAuditLog({
        organizationId: site.organizationId,
        actorId,
        actionType: "staging_enable_existing",
        resourceId: site.id,
        details: {
          ...enableAuditDetails,
          stagedDetected: true,
          capability: currentCapability
        },
        req
      });

      const targetLabel = stagingTargetLabel(currentCapability?.resourceKind);
      return NextResponse.json({
        enabled: true,
        stagedDetected: true,
        stagingCreationAttempted: false,
        stagingCreationRequestAccepted: false,
        stagingTargetResolved: true,
        message: `Staging ${targetLabel} is already detected in Coolify.`,
        capability: currentCapability
      });
    }

    const preferredStagingDomain = await deriveCoolifyStagingDomainFromProduction(appUuid);
    const provisionResult = await provisionCoolifyStagingFromProduction(appUuid, preferredStagingDomain, projectId);

    let capabilityAfterProvision = await getCoolifyAppStagingCapability(appUuid, projectId);
    if (!capabilityAfterProvision.applicationUuid) {
      for (const retryDelayMs of [250, 500]) {
        await sleep(retryDelayMs);
        const retriedCapability = await getCoolifyAppStagingCapability(appUuid, projectId);
        capabilityAfterProvision = retriedCapability;
        if (retriedCapability.applicationUuid) {
          break;
        }
      }
    }

    const stagingTargetResolved = Boolean(capabilityAfterProvision.detected && capabilityAfterProvision.applicationUuid);

    let stagingDomainApplied = false;
    if (preferredStagingDomain && capabilityAfterProvision.applicationUuid) {
      stagingDomainApplied = capabilityAfterProvision.resourceKind === "service"
        ? await applyCoolifyServiceDomains(capabilityAfterProvision.applicationUuid, preferredStagingDomain)
        : await applyCoolifyApplicationDomain(
            capabilityAfterProvision.applicationUuid,
            preferredStagingDomain
          );
    }

    await recordStagingAuditLog({
      organizationId: site.organizationId,
      actorId,
      actionType: "staging_enable_provision",
      resourceId: site.id,
      details: {
        ...enableAuditDetails,
        stagedDetected: stagingTargetResolved,
        provisioned: provisionResult.ok,
        manualProvisionRequired: !stagingTargetResolved,
        provisioningReason: provisionResult.reason ?? null,
        preferredStagingDomain: preferredStagingDomain ?? null,
        stagingDomainApplied,
        capability: capabilityAfterProvision,
        provisioningMessage: provisionResult.message
      },
      req
    });

    const targetLabel = stagingTargetLabel(capabilityAfterProvision?.resourceKind);
    const manualProvisionRequired = !stagingTargetResolved;
    const environmentOnlyProvisioned = provisionResult.reason === "environment_created";
    const actionHint = manualProvisionRequired
      ? (provisionResult.ok
        ? (environmentOnlyProvisioned
          ? `No staging resource was auto-cloned for this app on the current Coolify API path. Create or attach a staging ${targetLabel} target in Coolify, then refresh staging status in Jongo.`
          : `Attach or provision a staging ${targetLabel} target in Coolify for this app, then refresh staging status in Jongo.`)
          : "Create or attach a staging environment in Coolify for this app, then refresh staging status in Jongo.")
      : null;
    const enableMessage = manualProvisionRequired
      ? (provisionResult.ok
        ? (environmentOnlyProvisioned
          ? `Staging environment namespace was created in Coolify, but no staging ${targetLabel} was cloned or attached.`
          : `Staging environment is ready in Coolify, but no staging ${targetLabel} target is attached yet.`)
          : "Staging is enabled in Jongo. Automatic provisioning is unavailable for this app, so complete staging creation in Coolify.")
      : (provisionResult.ok
          ? provisionResult.message
          : `Staging is enabled in Jongo and a staging ${targetLabel} target is detected in Coolify.`);

    return NextResponse.json({
      enabled: true,
      stagedDetected: stagingTargetResolved,
      stagingCreationAttempted: true,
      stagingCreationRequestAccepted: Boolean(provisionResult.ok),
      stagingTargetResolved,
      provisioned: provisionResult.ok,
      manualProvisionRequired,
      provisioningReason: provisionResult.reason ?? null,
      actionHint,
      preferredStagingDomain,
      stagingDomainApplied,
      message: enableMessage,
      capability: capabilityAfterProvision
    });
  }

  let destroyResult: { ok: boolean; message: string } | null = null;
  let destroyEnvironmentResult: { ok: boolean; message: string; reason?: string } | null = null;
  let capability = null as Awaited<ReturnType<typeof getCoolifyAppStagingCapability>> | null;

  if (appUuid) {
    capability = await getCoolifyAppStagingCapability(appUuid, projectId);
    const shouldDestroy = Boolean(body.burnExisting) && Boolean(capability.detected && capability.applicationUuid);
    if (shouldDestroy && capability?.applicationUuid) {
      const result = await destroyCoolifyApplication(capability.applicationUuid);
      destroyResult = { ok: result.ok, message: result.message };
    }

    if (Boolean(body.burnExisting) && projectId) {
      const environmentResult = await deleteCoolifyStagingEnvironment(projectId);
      destroyEnvironmentResult = {
        ok: environmentResult.ok,
        message: environmentResult.message,
        reason: environmentResult.reason
      };
    }
  }

  const environmentDestroyed = destroyEnvironmentResult?.reason === "environment_deleted";
  const destroyed = Boolean(destroyResult?.ok || environmentDestroyed);
  const destroyActionType = destroyed ? "staging_disable_destroy" : "staging_disable_requested";

  await db.site.update({
    where: { id: site.id },
    data: { stagingEnabled: false }
  });

  await recordStagingAuditLog({
    organizationId: site.organizationId,
    actorId,
    actionType: destroyActionType,
    resourceId: site.id,
    details: {
      enabled: false,
      appUuid: appUuid || null,
      stagedDetected: Boolean(capability?.detected),
      destroyed,
      burnExisting: Boolean(body.burnExisting),
      message: destroyResult?.message ?? destroyEnvironmentResult?.message ?? "Staging disabled in Jongo."
    },
    req
  });

  return NextResponse.json({
    enabled: false,
    stagedDetected: Boolean(capability?.detected),
    destroyed,
    actionHint: !destroyed && Boolean(body.burnExisting)
      ? "Jongo disabled staging, but automatic cleanup failed. Remove staging resources manually in Coolify before re-enabling destructive cleanup."
      : null,
    message: destroyResult?.message ?? destroyEnvironmentResult?.message ?? "Staging disabled in Jongo."
  });
}

export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { siteId } = await params;

  let body: { domains?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.domains !== "string" || body.domains.trim().length === 0) {
    return NextResponse.json({ error: "'domains' must be a non-empty comma-separated string" }, { status: 400 });
  }

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
    return NextResponse.json({ error: "Only admins can manage staging domains" }, { status: 403 });
  }

  const appUuid = site.coolifyServiceUuid?.trim() || "";
  const projectId = site.coolifyProjectId?.trim() || undefined;
  if (!appUuid) {
    return NextResponse.json({ error: "Coolify service UUID is not linked." }, { status: 409 });
  }

  const capability = await getCoolifyAppStagingCapability(appUuid, projectId);
  if (!capability.detected || !capability.applicationUuid) {
    return NextResponse.json({
      error: "Staging application is not detected yet. Enable staging and verify Coolify staging app exists first."
    }, { status: 409 });
  }

  const requestedDomains = body.domains
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (requestedDomains.length === 0) {
    return NextResponse.json({ error: "No valid domains provided." }, { status: 400 });
  }

  const updated = await applyCoolifyApplicationDomains(capability.applicationUuid, requestedDomains);

  await recordStagingAuditLog({
    organizationId: site.organizationId,
    actorId: session.user.id,
    actionType: updated ? "staging_domains_updated" : "staging_domains_update_failed",
    resourceId: site.id,
    details: {
      domains: requestedDomains,
      stagingApplicationUuid: capability.applicationUuid,
      updated,
      message: updated
        ? "Staging domains updated in Coolify."
        : "Unable to update staging domains through the current Coolify API routes."
    },
    req
  });

  if (!updated) {
    return NextResponse.json({
      ok: false,
      stagingApplicationUuid: capability.applicationUuid,
      requestedDomains,
      message: "Unable to update staging domains through the current Coolify API routes."
    }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    stagingApplicationUuid: capability.applicationUuid,
    requestedDomains,
    message: "Staging domains updated in Coolify."
  });
}
