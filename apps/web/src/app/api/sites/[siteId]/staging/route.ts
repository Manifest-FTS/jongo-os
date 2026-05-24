import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { isAdminRole } from "@/lib/roles";
import {
  applyCoolifyApplicationDomain,
  applyCoolifyApplicationDomains,
  buildStagingSyncDryRunPlan,
  deriveCoolifyStagingDomainFromProduction,
  getCoolifyAppBackupInventory,
  destroyCoolifyApplication,
  getCoolifyAppStagingCapability,
  provisionCoolifyStagingFromProduction
} from "@/lib/coolify";
import { getBackupReadiness, getPathPreflight } from "@/lib/deploy-guards";

type Params = { params: Promise<{ siteId: string }> };

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

  const stagingConfigured = Boolean(site.stagingEnabled && stagingCapability?.detected);
  const backupReadiness = getBackupReadiness(backupInventory, appUuid || undefined);
  const productionToStaging = getPathPreflight("production-to-staging", backupReadiness, stagingConfigured);
  const stagingToProduction = getPathPreflight("staging-to-production", backupReadiness, stagingConfigured);

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
  if (!stagingCapability?.detected) {
    blockers.push("No staging environment/application is currently detected in Coolify.");
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
  if (site.stagingEnabled && appUuid && !stagingCapability?.detected) {
    suggestedActions.push("Staging is enabled but not detected yet. Verify Coolify staging support for this app and create/provision staging manually if auto-provision is unsupported.");
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
    if (currentCapability.detected) {
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

      return NextResponse.json({
        enabled: true,
        stagedDetected: true,
        message: "Staging is already detected in Coolify.",
        capability: currentCapability
      });
    }

    const preferredStagingDomain = await deriveCoolifyStagingDomainFromProduction(appUuid);
    const provisionResult = await provisionCoolifyStagingFromProduction(appUuid, preferredStagingDomain);
    const capabilityAfterProvision = await getCoolifyAppStagingCapability(appUuid, projectId);

    let stagingDomainApplied = false;
    if (preferredStagingDomain && capabilityAfterProvision.applicationUuid) {
      stagingDomainApplied = await applyCoolifyApplicationDomain(
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
        stagedDetected: capabilityAfterProvision.detected,
        provisioned: provisionResult.ok,
        preferredStagingDomain: preferredStagingDomain ?? null,
        stagingDomainApplied,
        capability: capabilityAfterProvision,
        provisioningMessage: provisionResult.message
      },
      req
    });

    return NextResponse.json({
      enabled: true,
      stagedDetected: capabilityAfterProvision.detected,
      provisioned: provisionResult.ok,
      preferredStagingDomain,
      stagingDomainApplied,
      message: provisionResult.message,
      capability: capabilityAfterProvision
    });
  }

  let destroyResult: { ok: boolean; message: string } | null = null;
  let capability = null as Awaited<ReturnType<typeof getCoolifyAppStagingCapability>> | null;

  if (appUuid) {
    capability = await getCoolifyAppStagingCapability(appUuid, projectId);
    const shouldDestroy = Boolean(body.burnExisting) && Boolean(capability.detected && capability.applicationUuid);
    if (shouldDestroy && capability?.applicationUuid) {
      const result = await destroyCoolifyApplication(capability.applicationUuid);
      destroyResult = { ok: result.ok, message: result.message };
    }
  }

  await db.site.update({
    where: { id: site.id },
    data: { stagingEnabled: false }
  });

  await recordStagingAuditLog({
    organizationId: site.organizationId,
    actorId,
    actionType: destroyResult?.ok ? "staging_disable_destroy" : "staging_disable_requested",
    resourceId: site.id,
    details: {
      enabled: false,
      appUuid: appUuid || null,
      stagedDetected: Boolean(capability?.detected),
      destroyed: Boolean(destroyResult?.ok),
      burnExisting: Boolean(body.burnExisting),
      message: destroyResult?.message ?? "Staging disabled in Jongo."
    },
    req
  });

  return NextResponse.json({
    enabled: false,
    stagedDetected: Boolean(capability?.detected),
    destroyed: Boolean(destroyResult?.ok),
    message: destroyResult?.message ?? "Staging disabled in Jongo."
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
