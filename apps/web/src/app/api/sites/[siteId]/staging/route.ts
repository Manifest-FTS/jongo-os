import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { isAdminRole } from "@/lib/roles";
import {
  buildStagingSyncDryRunPlan,
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

  return NextResponse.json({
    site: {
      id: site.id,
      slug: site.slug,
      name: site.name
    },
    generatedAt: new Date().toISOString(),
    stagingEnabled: site.stagingEnabled,
    stagingConfigured,
    readyForSyncTesting,
    blockers,
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
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
    return NextResponse.json({ error: "Only admins can manage staging" }, { status: 403 });
  }

  const appUuid = site.coolifyServiceUuid?.trim() || "";
  const projectId = site.coolifyProjectId?.trim() || undefined;

  if (body.enabled) {
    await db.site.update({
      where: { id: site.id },
      data: { stagingEnabled: true }
    });

    if (!appUuid) {
      return NextResponse.json({
        enabled: true,
        stagedDetected: false,
        message: "Staging enabled in Jongo. Link a Coolify Service UUID to provision or detect staging."
      });
    }

    const currentCapability = await getCoolifyAppStagingCapability(appUuid, projectId);
    if (currentCapability.detected) {
      return NextResponse.json({
        enabled: true,
        stagedDetected: true,
        message: "Staging is already detected in Coolify.",
        capability: currentCapability
      });
    }

    const provisionResult = await provisionCoolifyStagingFromProduction(appUuid);
    const capabilityAfterProvision = await getCoolifyAppStagingCapability(appUuid, projectId);

    return NextResponse.json({
      enabled: true,
      stagedDetected: capabilityAfterProvision.detected,
      provisioned: provisionResult.ok,
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

  return NextResponse.json({
    enabled: false,
    stagedDetected: Boolean(capability?.detected),
    destroyed: Boolean(destroyResult?.ok),
    message: destroyResult?.message ?? "Staging disabled in Jongo."
  });
}
