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
  triggerCoolifyDeploy,
  provisionCoolifyStagingFromProduction
} from "@/lib/coolify";
import { getBackupReadiness, getPathPreflight } from "@/lib/deploy-guards";

type Params = { params: Promise<{ siteId: string }> };

type StagingContentProbe = {
  checked: boolean;
  freshInstallDetected: boolean;
  checkedUrl?: string;
  finalUrl?: string;
  statusCode?: number;
  note?: string;
};

type AutoContentSyncResult = {
  attempted: boolean;
  ok: boolean;
  reason:
    | "completed"
    | "missing_config"
    | "missing_identifiers"
    | "command_failed"
    | "timed_out"
    | "not_required";
  message: string;
  responseTail?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tailLines(value: string, count = 12): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-count)
    .join("\n");
}

async function runAutoContentSync(params: {
  siteId: string;
  productionServiceUuid: string;
  stagingServiceUuid: string;
  stagingUrl: string;
  requestBaseUrl?: string;
}): Promise<AutoContentSyncResult> {
  const automationUrl = (process.env.STAGING_SYNC_AUTOMATION_URL || "").trim();
  const token = (process.env.OWNERSHIP_SYNC_TOKEN || "").trim();

  if (!automationUrl) {
    return {
      attempted: false,
      ok: false,
      reason: "missing_config",
      message: "Automatic content sync is not configured (missing STAGING_SYNC_AUTOMATION_URL)."
    };
  }

  if (!params.productionServiceUuid || !params.stagingServiceUuid || !params.stagingUrl) {
    return {
      attempted: false,
      ok: false,
      reason: "missing_identifiers",
      message: "Automatic content sync was skipped due to missing staging/prod identifiers."
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  const baseUrl = params.requestBaseUrl?.trim() || process.env.APP_BASE_URL || "http://localhost:3000";

  try {
    const response = await fetch(automationUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({
        siteId: params.siteId,
        productionServiceUuid: params.productionServiceUuid,
        stagingServiceUuid: params.stagingServiceUuid,
        stagingUrl: params.stagingUrl,
        appBaseUrl: baseUrl,
        mode: "apply"
      })
    });

    const responseText = await response.text();
    const responseTail = tailLines(responseText, 10);
    clearTimeout(timeout);

    if (!response.ok) {
      return {
        attempted: true,
        ok: false,
        reason: "command_failed",
        message: `Automatic content sync request failed (${response.status}).`,
        responseTail
      };
    }

    return {
      attempted: true,
      ok: true,
      reason: "completed",
      message: "Automatic content sync completed.",
      responseTail
    };
  } catch (error) {
    clearTimeout(timeout);
    const timedOut = error instanceof Error && error.name === "AbortError";
    return {
      attempted: true,
      ok: false,
      reason: timedOut ? "timed_out" : "command_failed",
      message: timedOut ? "Automatic content sync timed out." : "Automatic content sync failed."
    };
  }
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

function isLikelyWordPressInstallUrl(value?: string): boolean {
  if (!value) {
    return false;
  }

  return /\/wp-admin\/install\.php(?:[?#]|$)/i.test(value);
}

function normalizeProbeBaseUrl(url?: string): string | null {
  if (!url) {
    return null;
  }

  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withProtocol).toString();
  } catch {
    return null;
  }
}

async function probeStagingContent(stagingUrl?: string): Promise<StagingContentProbe> {
  const normalizedBaseUrl = normalizeProbeBaseUrl(stagingUrl);
  if (!normalizedBaseUrl) {
    return {
      checked: false,
      freshInstallDetected: false,
      note: "staging_url_unavailable"
    };
  }

  const candidates = [
    normalizedBaseUrl,
    new URL("/wp-admin/install.php", normalizedBaseUrl).toString()
  ];

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        method: "GET",
        redirect: "follow",
        cache: "no-store",
        headers: {
          "user-agent": "jongo-staging-content-probe/1.0"
        }
      });

      const finalUrl = response.url;
      const freshInstallDetected =
        isLikelyWordPressInstallUrl(finalUrl) ||
        (response.status === 200 && isLikelyWordPressInstallUrl(candidate));

      return {
        checked: true,
        freshInstallDetected,
        checkedUrl: candidate,
        finalUrl,
        statusCode: response.status,
        note: freshInstallDetected ? "wordpress_install_screen_detected" : "ok"
      };
    } catch {
      // Continue to fallback probe candidate.
    }
  }

  return {
    checked: false,
    freshInstallDetected: false,
    checkedUrl: normalizedBaseUrl,
    note: "probe_failed"
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
  const stagingContentProbe = await probeStagingContent(stagingCapability?.stagingUrl);

  const actualSyncChecks = [
    "Staging is configured and target is attached.",
    "Production-to-staging preflight is healthy.",
    "Dry-run plan resolves target, database behavior, and files behavior.",
    "Current pass scope allows real file+DB production sync testing for this resource type."
  ];

  const actualSyncBlockers: string[] = [];
  if (!stagingConfigured) {
    actualSyncBlockers.push("Staging is not fully configured.");
  }
  if (stagingCapability?.status !== "healthy") {
    actualSyncBlockers.push("Staging target is not healthy yet.");
  }
  if (productionToStaging.tone !== "healthy") {
    actualSyncBlockers.push(`Preflight is not healthy: ${productionToStaging.detail}`);
  }
  if (!dryRunPlan?.target) {
    actualSyncBlockers.push("Dry-run plan does not resolve a staging target.");
  }
  if (dryRunPlan?.databaseBehavior && dryRunPlan.databaseBehavior !== "snapshot-then-overwrite") {
    actualSyncBlockers.push(`Unexpected database behavior: ${dryRunPlan.databaseBehavior}.`);
  }
  if (dryRunPlan?.filesBehavior && dryRunPlan.filesBehavior !== "rsync-overwrite") {
    actualSyncBlockers.push(`Unexpected files behavior: ${dryRunPlan.filesBehavior}.`);
  }
  if (stagingContentProbe.freshInstallDetected) {
    actualSyncBlockers.push("Staging content still appears to be a fresh WordPress install (install.php detected). Run a production-to-staging content sync before live sync testing.");
  }
  const actualSyncReady = actualSyncBlockers.length === 0;
  const actualSyncTestReadiness = {
    ready: actualSyncReady,
    tone: (actualSyncReady ? "healthy" : "error") as "healthy" | "error",
    label: actualSyncReady ? "Ready" : "Not ready",
    summary: actualSyncReady
      ? "Prerequisites are satisfied for a controlled production file+DB sync test."
      : "Do not run live production file+DB sync testing yet.",
    blockers: actualSyncBlockers,
    checks: actualSyncChecks
  };

  const readyForSyncTesting = Boolean(
    stagingConfigured &&
    stagingCapability?.status === "healthy" &&
    !backupReadiness.locked &&
    dryRunPlan?.target &&
    actualSyncReady
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
  if (site.stagingEnabled && stagingCapability?.detected && stagingCapability?.applicationUuid && stagingCapability.status !== "healthy") {
    blockers.push("Staging target is attached but not running/deployed in Coolify.");
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
  if (site.stagingEnabled && stagingCapability?.detected && stagingCapability?.applicationUuid && stagingCapability.status !== "healthy") {
    suggestedActions.push("Start/deploy the staging target in Coolify, then re-run staging preflight in Jongo.");
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
    actualSyncTestReadiness,
    preflight: {
      productionToStaging,
      stagingToProduction
    },
    stagingCapability,
    stagingContentProbe,
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
        message: "Staging enabled in Jongo. Link a service UUID to provision or detect staging."
      });
    }

    const currentCapability = await getCoolifyAppStagingCapability(appUuid, projectId);
    const currentStagingTargetResolved = Boolean(currentCapability.detected && currentCapability.applicationUuid);
    if (currentStagingTargetResolved) {
      let capabilityAfterExistingCheck = currentCapability;
      let currentStagingRunning = capabilityAfterExistingCheck.status === "healthy";
      let stagingDeployTriggered = false;

      if (
        !currentStagingRunning &&
        capabilityAfterExistingCheck.resourceKind === "service" &&
        capabilityAfterExistingCheck.applicationUuid
      ) {
        try {
          await triggerCoolifyDeploy(capabilityAfterExistingCheck.applicationUuid, "staging");
          stagingDeployTriggered = true;
        } catch {
          stagingDeployTriggered = false;
        }

        if (stagingDeployTriggered) {
          await sleep(500);
          capabilityAfterExistingCheck = await getCoolifyAppStagingCapability(appUuid, projectId);
          currentStagingRunning = capabilityAfterExistingCheck.status === "healthy";
        }
      }

      const preferredStagingDomain = await deriveCoolifyStagingDomainFromProduction(appUuid);
      const stagingDomainApplied = preferredStagingDomain && capabilityAfterExistingCheck.applicationUuid
        ? (capabilityAfterExistingCheck.resourceKind === "service"
            ? await applyCoolifyServiceDomains(capabilityAfterExistingCheck.applicationUuid, preferredStagingDomain)
            : await applyCoolifyApplicationDomain(capabilityAfterExistingCheck.applicationUuid, preferredStagingDomain))
        : false;
      await recordStagingAuditLog({
        organizationId: site.organizationId,
        actorId,
        actionType: "staging_enable_existing",
        resourceId: site.id,
        details: {
          ...enableAuditDetails,
          stagedDetected: true,
          preferredStagingDomain: preferredStagingDomain ?? null,
          stagingDomainApplied,
          stagingDeployTriggered,
          capability: capabilityAfterExistingCheck
        },
        req
      });

      const targetLabel = stagingTargetLabel(capabilityAfterExistingCheck?.resourceKind);
      return NextResponse.json({
        enabled: true,
        stagedDetected: true,
        stagingCreationAttempted: false,
        stagingCreationRequestAccepted: false,
        stagingTargetResolved: true,
        preferredStagingDomain,
        stagingDomainApplied,
        stagingDeployTriggered,
        stagingRunning: currentStagingRunning,
        actionHint: currentStagingRunning
          ? null
          : `Staging ${targetLabel} is attached and still coming online. Refresh in a moment.`,
        message: currentStagingRunning
          ? `Staging ${targetLabel} is already detected.`
          : `Staging ${targetLabel} is detected and still coming online. Refresh in a moment.`,
        capability: capabilityAfterExistingCheck
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

    let stagingDeployTriggered = false;
    if (
      stagingTargetResolved &&
      capabilityAfterProvision.resourceKind === "service" &&
      capabilityAfterProvision.applicationUuid &&
      capabilityAfterProvision.status !== "healthy"
    ) {
      try {
        await triggerCoolifyDeploy(capabilityAfterProvision.applicationUuid, "staging");
        stagingDeployTriggered = true;
      } catch {
        stagingDeployTriggered = false;
      }

      if (stagingDeployTriggered) {
        await sleep(500);
        capabilityAfterProvision = await getCoolifyAppStagingCapability(appUuid, projectId);
      }
    }

    let stagingDomainApplied = false;
    if (preferredStagingDomain && capabilityAfterProvision.applicationUuid) {
      stagingDomainApplied = capabilityAfterProvision.resourceKind === "service"
        ? await applyCoolifyServiceDomains(capabilityAfterProvision.applicationUuid, preferredStagingDomain)
        : await applyCoolifyApplicationDomain(
            capabilityAfterProvision.applicationUuid,
            preferredStagingDomain
          );
    }

    const targetLabel = stagingTargetLabel(capabilityAfterProvision?.resourceKind);
    const manualProvisionRequired = !stagingTargetResolved;
    const stagingRunning = capabilityAfterProvision.status === "healthy";
    const requiresContentSync = provisionResult.reason === "service_created";
    const environmentOnlyProvisioned = provisionResult.reason === "environment_created";
    const requestBaseUrl = (() => {
      try {
        return new URL(req.url).origin;
      } catch {
        return process.env.APP_BASE_URL || "";
      }
    })();
    const derivedStagingUrl = (
      capabilityAfterProvision.stagingUrl ||
      capabilityAfterProvision.fqdn?.split(",")[0]?.trim() ||
      preferredStagingDomain ||
      ""
    ).trim();

    const autoContentSync = requiresContentSync
      ? await runAutoContentSync({
          siteId: site.slug || site.id,
          productionServiceUuid: appUuid,
          stagingServiceUuid: capabilityAfterProvision.applicationUuid || "",
          stagingUrl: derivedStagingUrl,
          requestBaseUrl
        })
      : {
          attempted: false,
          ok: false,
          reason: "not_required",
          message: "Automatic content sync not required."
        };

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
        stagingDeployTriggered,
        capability: capabilityAfterProvision,
        provisioningMessage: provisionResult.message,
        autoContentSync
      },
      req
    });

    const actionHint = manualProvisionRequired
      ? (provisionResult.ok
        ? (environmentOnlyProvisioned
          ? "Staging is being provisioned in Coolify. Check the Staging tab in a few minutes."
          : "Check the Staging tab in Coolify and refresh in a few minutes.")
          : "Check the Staging tab in Coolify and refresh in a few minutes.")
      : requiresContentSync
        ? (autoContentSync.ok
          ? "Staging target was created and content sync completed automatically. Refresh in a moment."
          : "Staging target was created from service settings only. Automatic content sync did not complete. Retry content sync from Operations.")
      : !stagingRunning
        ? `Staging ${targetLabel} is attached and still coming online. Refresh in a moment.`
      : null;
    const enableMessage = manualProvisionRequired
      ? (provisionResult.ok
        ? (environmentOnlyProvisioned
          ? "Staging is being provisioned in Coolify. Check the Staging tab in a few minutes."
          : "Staging is being provisioned in Coolify. Check the Staging tab in a few minutes.")
          : "Staging is enabled in Jongo, but automatic provisioning is unavailable for this app. Check the Staging tab in Coolify.")
      : (requiresContentSync && autoContentSync.ok)
        ? "Staging target was created in Coolify and content sync completed automatically."
      : !stagingRunning
        ? `Staging ${targetLabel} is detected and still coming online.`
      : (provisionResult.ok
          ? provisionResult.message
          : `Staging is enabled in Jongo and a staging ${targetLabel} target is detected.`);

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
      stagingDeployTriggered,
      stagingRunning,
      autoContentSync,
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
      const result = await destroyCoolifyApplication(capability.applicationUuid, capability.resourceKind);
      destroyResult = { ok: result.ok, message: result.message };

      if (!destroyResult.ok) {
        const afterDestroyProbe = await getCoolifyAppStagingCapability(appUuid, projectId);
        if (!afterDestroyProbe.applicationUuid) {
          destroyResult = {
            ok: true,
            message: "Staging target is no longer attached in Coolify."
          };
        }
      }
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
      ? "Jongo disabled staging, but automatic cleanup failed. Remove staging resources manually in the infrastructure panel before re-enabling destructive cleanup."
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
      error: "Staging application is not detected yet. Enable staging and verify the staging resource exists first."
    }, { status: 409 });
  }

  const requestedDomains = body.domains
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (requestedDomains.length === 0) {
    return NextResponse.json({ error: "No valid domains provided." }, { status: 400 });
  }

  const updated = capability.resourceKind === "service"
    ? await applyCoolifyServiceDomains(capability.applicationUuid, requestedDomains)
    : await applyCoolifyApplicationDomains(capability.applicationUuid, requestedDomains);

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
        ? "Staging domains updated."
        : "Unable to update staging domains through the current API routes."
    },
    req
  });

  if (!updated) {
    return NextResponse.json({
      ok: false,
      stagingApplicationUuid: capability.applicationUuid,
      requestedDomains,
      message: "Unable to update staging domains through the current API routes."
    }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    stagingApplicationUuid: capability.applicationUuid,
    requestedDomains,
    message: "Staging domains updated."
  });
}
