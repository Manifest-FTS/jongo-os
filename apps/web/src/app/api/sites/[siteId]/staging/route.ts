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
  isGeneratedCoolifyHost,
  readCoolifyServiceDomains,
  restartCoolifyService,
  triggerCoolifyDeploy,
  provisionCoolifyStagingFromProduction
} from "@/lib/coolify";
import { importLinkedCoolifyProjectSites } from "@/lib/coolify-project-import";
import { getBackupReadiness, getPathPreflight } from "@/lib/deploy-guards";
import { getSiteWorkspace } from "@/lib/repositories";
import { StagingProvisioningPipeline } from "@/orchestration/staging";

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

type CoolifyDomainSyncAttempt = {
  method: "PATCH" | "POST";
  path: string;
  body: Record<string, unknown>;
};

type CoolifyDomainSyncResult = {
  ok: boolean;
  status?: number;
  message: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeHostForCompare(value: string): string {
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
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
  direction?: "production-to-staging" | "staging-to-production";
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
  const timeout = setTimeout(() => controller.abort(), 120_000);
  const baseUrl = params.requestBaseUrl?.trim() || process.env.APP_BASE_URL || "http://localhost:3000";

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
        direction: params.direction ?? "production-to-staging",
        appBaseUrl: baseUrl,
        mode: "apply"
      })
    });

    const responseText = await response.text();
    const responseTail = tailLines(responseText, 10);
    clearTimeout(timeout);

    if (response.status >= 300 && response.status < 400) {
      return {
        attempted: true,
        ok: false,
        reason: "command_failed",
        message: `Automatic content sync request redirected (${response.status}).`,
        responseTail: response.headers.get("location") ?? responseTail
      };
    }

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

async function runCoolifyDomainSyncAttempt(attempt: CoolifyDomainSyncAttempt): Promise<CoolifyDomainSyncResult> {
  const baseUrl = process.env.COOLIFY_API_BASE_URL?.trim();
  const token = process.env.COOLIFY_API_TOKEN?.trim();

  if (!baseUrl || !token) {
    return {
      ok: false,
      message: "Coolify API credentials are missing on this server."
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.COOLIFY_TIMEOUT_MS ?? 8000));

  try {
    const response = await fetch(`${baseUrl}${attempt.path}`, {
      method: attempt.method,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(attempt.body),
      signal: controller.signal
    });

    if (response.ok) {
      return {
        ok: true,
        status: response.status,
        message: "Staging domains updated."
      };
    }

    let bodyMessage = "";
    try {
      const payload = await response.json() as Record<string, unknown>;
      const message = typeof payload.message === "string" ? payload.message : "";
      const errors = payload.errors ? JSON.stringify(payload.errors) : "";
      const conflicts = payload.conflicts ? JSON.stringify(payload.conflicts) : "";
      bodyMessage = [message, errors, conflicts].filter(Boolean).join(" ").trim();
    } catch {
      try {
        bodyMessage = (await response.text()).trim();
      } catch {
        bodyMessage = "";
      }
    }

    return {
      ok: false,
      status: response.status,
      message: bodyMessage || `Coolify returned HTTP ${response.status} while updating staging domains.`
    };
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      message: isTimeout
        ? "Coolify API timed out while updating staging domains."
        : "Could not reach the Coolify API while updating staging domains."
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveCoolifyServiceApplicationNames(serviceUuid: string): Promise<string[]> {
  const baseUrl = process.env.COOLIFY_API_BASE_URL?.trim();
  const token = process.env.COOLIFY_API_TOKEN?.trim();

  if (!baseUrl || !token) {
    return [];
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.COOLIFY_TIMEOUT_MS ?? 8000));

  try {
    const response = await fetch(`${baseUrl}/api/v1/services/${encodeURIComponent(serviceUuid)}`, {
      method: "GET",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`
      },
      signal: controller.signal
    });

    if (!response.ok) {
      return [];
    }

    const payload = await response.json() as Record<string, unknown>;
    const applications = Array.isArray(payload.applications)
      ? payload.applications.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
      : [];
    const names = applications
      .map((application) => {
        const candidate = application.name;
        return typeof candidate === "string" ? candidate.trim() : "";
      })
      .filter((value) => value.length > 0);

    return [...new Set(names)];
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function retryCoolifyDomainSyncWithDiagnostics(params: {
  resourceKind?: string;
  resourceUuid: string;
  domains: string[];
}): Promise<CoolifyDomainSyncResult> {
  const normalizedDomains = params.domains
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => (/^https?:\/\//i.test(value) ? value : `https://${value}`));

  if (normalizedDomains.length === 0) {
    return {
      ok: false,
      message: "No valid domains were provided for sync."
    };
  }

  const domainCsv = normalizedDomains.join(",");
  const serviceApplicationNames = params.resourceKind === "service"
    ? await resolveCoolifyServiceApplicationNames(params.resourceUuid)
    : [];
  const namedServiceUrls = serviceApplicationNames.length > 0
    ? [{
        name: serviceApplicationNames[0],
        url: normalizedDomains.join(",")
      }]
    : [];
  const attempts: CoolifyDomainSyncAttempt[] = params.resourceKind === "service"
    ? [
        ...(namedServiceUrls.length > 0
          ? [{
              method: "PATCH" as const,
              path: `/api/v1/services/${encodeURIComponent(params.resourceUuid)}`,
              body: {
                urls: namedServiceUrls,
                force_domain_override: true
              }
            }]
          : []),
        ...(namedServiceUrls.length > 0
          ? [{
              method: "POST" as const,
              path: `/api/v1/services/${encodeURIComponent(params.resourceUuid)}`,
              body: {
                urls: namedServiceUrls,
                force_domain_override: true
              }
            }]
          : []),
        {
          method: "PATCH",
          path: `/api/v1/services/${encodeURIComponent(params.resourceUuid)}`,
          body: {
            urls: normalizedDomains.map((url, index) => ({
              name: index === 0 ? "default" : `domain-${index + 1}`,
              url
            })),
            force_domain_override: true
          }
        },
        {
          method: "POST",
          path: `/api/v1/services/${encodeURIComponent(params.resourceUuid)}`,
          body: {
            urls: normalizedDomains.map((url, index) => ({
              name: index === 0 ? "default" : `domain-${index + 1}`,
              url
            })),
            force_domain_override: true
          }
        }
      ]
    : [
        {
          method: "PATCH",
          path: `/api/v1/applications/${encodeURIComponent(params.resourceUuid)}`,
          body: { domains: domainCsv }
        },
        {
          method: "POST",
          path: `/api/v1/applications/${encodeURIComponent(params.resourceUuid)}`,
          body: { domains: domainCsv }
        }
      ];

  let lastFailure: CoolifyDomainSyncResult = {
    ok: false,
    message: "Coolify rejected staging domain updates."
  };

  for (const attempt of attempts) {
    const result = await runCoolifyDomainSyncAttempt(attempt);
    if (result.ok) {
      return result;
    }
    lastFailure = result;
  }

  return lastFailure;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeEmail(value?: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

function hasBootstrapGlobalAccess(session: Awaited<ReturnType<typeof auth>>): boolean {
  const configuredAdmin = normalizeEmail(process.env.BOOTSTRAP_ADMIN_EMAIL);
  const sessionEmail = normalizeEmail(session?.user?.email);
  if (!configuredAdmin || !sessionEmail) {
    return false;
  }

  return configuredAdmin === sessionEmail;
}

function buildSiteIdentityWhere(siteId: string) {
  const normalizedSiteId = decodeURIComponent(siteId).trim();

  if (!normalizedSiteId) {
    return {
      slug: siteId,
      deletedAt: null
    };
  }

  if (isUuid(normalizedSiteId)) {
    return {
      OR: [
        { id: normalizedSiteId },
        { slug: normalizedSiteId },
        { coolifyServiceUuid: normalizedSiteId },
        { coolifyServiceId: normalizedSiteId }
      ],
      deletedAt: null
    };
  }

  return {
    slug: normalizedSiteId,
    deletedAt: null
  };
}

function isPrismaSchemaMismatchError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const e = error as { code?: string; message?: string; meta?: { message?: string } };
  const message = `${e.message ?? ""} ${e.meta?.message ?? ""}`.toLowerCase();

  return (
    e.code === "P2022" ||
    (message.includes("column") && message.includes("does not exist")) ||
    (message.includes("the column") && message.includes("does not exist"))
  );
}

async function tryAutoImportMappedCoolifySite(params: {
  db: any;
  siteId: string;
  session: Awaited<ReturnType<typeof auth>>;
  bootstrapGlobalAccess: boolean;
  authorizedByToken: boolean;
}): Promise<boolean> {
  const sessionUserId = params.session?.user?.id;
  const viewer = {
    userId: sessionUserId,
    email: params.session?.user?.email
  };

  const workspace = await getSiteWorkspace(params.siteId, viewer);
  if (!workspace || workspace.source !== "coolify") {
    return false;
  }

  const coolifyProjectId = workspace.coolifyProjectId?.trim();
  if (!coolifyProjectId) {
    return false;
  }

  const candidateOrg = await params.db.organization.findFirst({
    where: {
      deletedAt: null,
      OR: [
        { coolifyProjectId },
        {
          coolifyProjectLinks: {
            some: {
              coolifyProjectId,
              deletedAt: null
            }
          }
        }
      ]
    },
    select: {
      id: true,
      ownerId: true,
      collaborators: sessionUserId
        ? {
            where: {
              userId: sessionUserId,
              deletedAt: null
            },
            select: { id: true },
            take: 1
          }
        : {
            where: { deletedAt: null },
            select: { id: true },
            take: 1
          }
    }
  });

  if (!candidateOrg) {
    return false;
  }

  const allowedByOwnership = Boolean(
    sessionUserId && (
      candidateOrg.ownerId === sessionUserId ||
      candidateOrg.collaborators.length > 0
    )
  );

  if (!params.authorizedByToken && !params.bootstrapGlobalAccess && !allowedByOwnership) {
    return false;
  }

  try {
    await importLinkedCoolifyProjectSites(candidateOrg.id);
    return true;
  } catch (error) {
    console.error("[staging] automatic Coolify site import failed", {
      siteId: params.siteId,
      coolifyProjectId,
      organizationId: candidateOrg.id,
      error
    });
    return false;
  }
}

let hasCheckedTemporaryDomainColumns = false;
let temporaryDomainColumnsAvailable = false;

async function hasTemporaryDomainColumns(db: any): Promise<boolean> {
  if (hasCheckedTemporaryDomainColumns) {
    return temporaryDomainColumnsAvailable;
  }

  try {
    const columns = await db.$queryRaw<Array<{ columnName: string }>>`
      select column_name as "columnName"
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'Site'
        and column_name in ('temporaryDomainSlug', 'temporaryDomainSuffix')
    `;

    const available = new Set(columns.map((column: { columnName: string }) => column.columnName));
    temporaryDomainColumnsAvailable =
      available.has("temporaryDomainSlug") && available.has("temporaryDomainSuffix");
    hasCheckedTemporaryDomainColumns = true;
    return temporaryDomainColumnsAvailable;
  } catch {
    hasCheckedTemporaryDomainColumns = true;
    temporaryDomainColumnsAvailable = false;
    return false;
  }
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

function buildStagingProbeCandidates(params: {
  preferredStagingDomain?: string;
  stagingUrl?: string;
  fqdn?: string;
}): string[] {
  const candidates = [
    params.stagingUrl,
    ...(params.fqdn ? params.fqdn.split(",").map((value) => value.trim()) : []),
    params.preferredStagingDomain
  ]
    .map((value) => value?.trim() ?? "")
    .filter(Boolean);

  return [...new Set(candidates)];
}

function toHostname(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withProtocol);
    return parsed.hostname.trim().toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

function extractHostList(raw?: string): string[] {
  if (!raw) {
    return [];
  }

  const hosts = raw
    .split(",")
    .map((entry) => toHostname(entry))
    .filter((entry): entry is string => Boolean(entry));

  return [...new Set(hosts)];
}

function buildPreferredDomainConvergence(params: {
  preferredStagingDomain?: string;
  capabilityFqdn?: string;
  capabilityStagingUrl?: string;
}): {
  preferredHost?: string;
  reportedHosts: string[];
  converged: boolean;
} {
  const preferredHost = toHostname(params.preferredStagingDomain);
  const reportedHosts = [...new Set([
    ...extractHostList(params.capabilityFqdn),
    ...extractHostList(params.capabilityStagingUrl)
  ])];

  return {
    preferredHost,
    reportedHosts,
    converged: preferredHost ? reportedHosts.includes(preferredHost) : true
  };
}

function mergeActionHints(primary?: string | null, secondary?: string | null): string | null {
  const first = primary?.trim();
  const second = secondary?.trim();

  if (first && second) {
    return `${first} ${second}`;
  }

  return first ?? second ?? null;
}

async function probeStagingContentAcrossCandidates(candidates: string[]): Promise<{
  probe: StagingContentProbe;
  checkedCandidates: string[];
  matchedCandidate?: string;
}> {
  const checkedCandidates: string[] = [];
  let firstCheckedProbe: StagingContentProbe | null = null;
  let firstCheckedCandidate: string | undefined;

  for (const candidate of candidates) {
    checkedCandidates.push(candidate);
    const probe = await probeStagingContent(candidate);

    if (probe.checked && !firstCheckedProbe) {
      firstCheckedProbe = probe;
      firstCheckedCandidate = candidate;
    }

    if (probe.freshInstallDetected) {
      return {
        probe,
        checkedCandidates,
        matchedCandidate: candidate
      };
    }
  }

  if (firstCheckedProbe) {
    return {
      probe: firstCheckedProbe,
      checkedCandidates,
      matchedCandidate: firstCheckedCandidate
    };
  }

  return {
    probe: {
      checked: false,
      freshInstallDetected: false,
      note: "probe_failed"
    },
    checkedCandidates
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

async function tryRecordStagingAuditLog(params: {
  organizationId: string;
  actorId?: string;
  actionType: string;
  resourceId: string;
  details: Record<string, unknown>;
  req: Request;
}) {
  try {
    await recordStagingAuditLog(params);
  } catch (error) {
    console.error("[staging] Failed to write staging audit log", {
      actionType: params.actionType,
      resourceId: params.resourceId,
      error
    });
  }
}

export async function GET(_req: Request, { params }: Params) {
  const authorizedByToken = hasOpsToken(_req);
  const session = await auth();
  const bootstrapGlobalAccess = hasBootstrapGlobalAccess(session);
  if (!session?.user?.id && !authorizedByToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { siteId } = await params;
  const { db } = await import("@/lib/db");

  const lookupWhere = (resolvedSiteId: string) => (
    authorizedByToken || bootstrapGlobalAccess
      ? {
          ...buildSiteIdentityWhere(resolvedSiteId)
        }
      : {
          ...buildSiteIdentityWhere(resolvedSiteId),
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
        }
  );

  let site = await db.site.findFirst({
    where: lookupWhere(siteId),
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
    const imported = await tryAutoImportMappedCoolifySite({
      db,
      siteId,
      session,
      bootstrapGlobalAccess,
      authorizedByToken
    });

    if (imported) {
      site = await db.site.findFirst({
        where: lookupWhere(siteId),
        select: {
          id: true,
          slug: true,
          name: true,
          stagingEnabled: true,
          coolifyServiceUuid: true,
          coolifyProjectId: true
        }
      });
    }
  }

  if (!site) {
    return NextResponse.json({ error: "Not found or insufficient permissions" }, { status: 404 });
  }

  let temporaryDomainSlug: string | null = null;
  let temporaryDomainSuffix: string | null = null;
  if (await hasTemporaryDomainColumns(db)) {
    try {
      const temporaryDomainValues = await db.site.findUnique({
        where: { id: site.id },
        select: {
          temporaryDomainSlug: true,
          temporaryDomainSuffix: true
        }
      });
      temporaryDomainSlug = temporaryDomainValues?.temporaryDomainSlug ?? null;
      temporaryDomainSuffix = temporaryDomainValues?.temporaryDomainSuffix ?? null;
    } catch (error) {
      if (!isPrismaSchemaMismatchError(error)) {
        throw error;
      }

      hasCheckedTemporaryDomainColumns = true;
      temporaryDomainColumnsAvailable = false;
    }
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
      coolifyProjectId: site.coolifyProjectId,
      temporaryDomainSlug,
      temporaryDomainSuffix
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
  const bootstrapGlobalAccess = hasBootstrapGlobalAccess(session);
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

  try {

  const { db } = await import("@/lib/db");
  const siteSelect = {
    id: true,
    organizationId: true,
    slug: true,
    name: true,
    stagingEnabled: true,
    coolifyServiceUuid: true,
    coolifyProjectId: true,
    organization: {
      select: {
        id: true,
        ownerId: true,
        collaborators: session?.user?.id
          ? { where: { userId: session.user.id }, select: { role: true } }
          : { select: { role: true }, take: 1 }
      }
    }
  };

  const siteWhere =
    authorizedByToken || bootstrapGlobalAccess
      ? {
          where: {
            ...buildSiteIdentityWhere(siteId)
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
          }
        };

  let site = await db.site.findFirst({ ...siteWhere, select: siteSelect });

  if (!site) {
    const imported = await tryAutoImportMappedCoolifySite({
      db,
      siteId,
      session,
      bootstrapGlobalAccess,
      authorizedByToken
    });

    if (imported) {
      site = await db.site.findFirst({ ...siteWhere, select: siteSelect });
    }
  }

  if (!site) {
    return NextResponse.json({ error: "Not found or insufficient permissions" }, { status: 404 });
  }

  const callerIsOwner = Boolean(session?.user?.id && site.organization.ownerId === session.user.id);
  const callerIsAdmin =
    authorizedByToken ||
    bootstrapGlobalAccess ||
    callerIsOwner ||
    isAdminRole(site.organization.collaborators[0]?.role);
  if (!callerIsAdmin) {
    return NextResponse.json({ error: "Only admins can manage staging" }, { status: 403 });
  }

  const appUuid = site.coolifyServiceUuid?.trim() || "";
  const projectId = site.coolifyProjectId?.trim() || undefined;
  let temporaryDomainSlug: string | null = null;
  if (await hasTemporaryDomainColumns(db)) {
    try {
      const temporaryDomainValues = await db.site.findUnique({
        where: { id: site.id },
        select: {
          temporaryDomainSlug: true
        }
      });
      temporaryDomainSlug = temporaryDomainValues?.temporaryDomainSlug ?? null;
    } catch (error) {
      if (!isPrismaSchemaMismatchError(error)) {
        throw error;
      }

      hasCheckedTemporaryDomainColumns = true;
      temporaryDomainColumnsAvailable = false;
    }
  }

  if (body.enabled) {
    if (!site.stagingEnabled && appUuid) {
      const residualCapability = await getCoolifyAppStagingCapability(appUuid, projectId);
      if (residualCapability.applicationUuid) {
        const targetLabel = stagingTargetLabel(residualCapability.resourceKind);
        return NextResponse.json({
          error: "Staging re-enable is locked until existing staging resources are fully removed.",
          actionHint: `Existing staging ${targetLabel} resources are still detected. Finish unprovision/deletion in Coolify, then re-enable staging.`
        }, { status: 409 });
      }
    }

    await db.site.update({
      where: { id: site.id },
      data: { stagingEnabled: true },
      select: { id: true }
    });

    const enableAuditDetails: Record<string, unknown> = {
      enabled: true,
      appUuid: appUuid || null
    };

    if (!appUuid) {
      await tryRecordStagingAuditLog({
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

      let stagingDomainApplied = false;

      const preferredStagingDomain = await deriveCoolifyStagingDomainFromProduction(appUuid, {
        siteSlug: temporaryDomainSlug ?? site.slug ?? site.id,
        siteName: site.name
      });

      if (capabilityAfterExistingCheck.resourceKind === "service" && capabilityAfterExistingCheck.applicationUuid && preferredStagingDomain) {
        const pipeline = new StagingProvisioningPipeline({
          serviceUuid: capabilityAfterExistingCheck.applicationUuid,
          desiredDomain: preferredStagingDomain
        });
        const result = await pipeline.execute();
        stagingDomainApplied = result.success;
        stagingDeployTriggered = result.success;
      } else if (capabilityAfterExistingCheck.resourceKind === "application" && capabilityAfterExistingCheck.applicationUuid && preferredStagingDomain) {
        stagingDomainApplied = await applyCoolifyApplicationDomain(capabilityAfterExistingCheck.applicationUuid, preferredStagingDomain);
        try {
          await triggerCoolifyDeploy(capabilityAfterExistingCheck.applicationUuid, "staging");
          stagingDeployTriggered = true;
        } catch { }
      }

      if (capabilityAfterExistingCheck.applicationUuid && !currentStagingRunning && !stagingDeployTriggered) {
        try {
          await triggerCoolifyDeploy(capabilityAfterExistingCheck.applicationUuid, "staging");
          stagingDeployTriggered = true;
          const refreshedCapability = await getCoolifyAppStagingCapability(appUuid, projectId);
          capabilityAfterExistingCheck = refreshedCapability;
          currentStagingRunning = refreshedCapability.status === "healthy";
        } catch { }
      }

      const requestBaseUrl = (() => {
        try {
          return new URL(req.url).origin;
        } catch {
          return process.env.APP_BASE_URL || "";
        }
      })();
      
      const domainConvergence = buildPreferredDomainConvergence({
        preferredStagingDomain,
        capabilityFqdn: capabilityAfterExistingCheck.fqdn,
        capabilityStagingUrl: capabilityAfterExistingCheck.stagingUrl
      });
      const preferredDomainPendingHint = preferredStagingDomain && !domainConvergence.converged
        ? `Preferred staging URL ${preferredStagingDomain} is not active yet. Coolify is still serving ${domainConvergence.reportedHosts[0] ? `https://${domainConvergence.reportedHosts[0]}` : "a generated staging host"}.`
        : null;
      const probeCandidates = buildStagingProbeCandidates({
        preferredStagingDomain,
        stagingUrl: capabilityAfterExistingCheck.stagingUrl,
        fqdn: capabilityAfterExistingCheck.fqdn
      });
      const stagingProbeResult = await probeStagingContentAcrossCandidates(probeCandidates);
      const freshInstallDetected = stagingProbeResult.probe.freshInstallDetected;
      const probeUnavailable = !stagingProbeResult.probe.checked;
      const requiresContentSync = freshInstallDetected || probeUnavailable;
      const autoSyncStagingUrl = (
        stagingProbeResult.matchedCandidate ||
        preferredStagingDomain ||
        capabilityAfterExistingCheck.stagingUrl ||
        capabilityAfterExistingCheck.fqdn?.split(",")[0]?.trim() ||
        ""
      ).trim();

      let autoContentSync: AutoContentSyncResult = {
        attempted: false,
        ok: false,
        reason: "not_required",
        message: "Automatic content sync not required."
      };

      if (requiresContentSync && capabilityAfterExistingCheck.applicationUuid) {
        autoContentSync = await runAutoContentSync({
          siteId: site.id,
          productionServiceUuid: appUuid,
          stagingServiceUuid: capabilityAfterExistingCheck.applicationUuid,
          stagingUrl: autoSyncStagingUrl,
          requestBaseUrl,
          direction: "production-to-staging"
        });
      }

      await tryRecordStagingAuditLog({
        organizationId: site.organizationId,
        actorId,
        actionType: "staging_enable_existing",
        resourceId: site.id,
        details: {
          ...enableAuditDetails,
          stagedDetected: true,
          provisioned: false,
          manualProvisionRequired: false,
          preferredStagingDomain: preferredStagingDomain ?? null,
          stagingDomainApplied,
          stagingDeployTriggered,
          preferredStagingHost: domainConvergence.preferredHost ?? null,
          reportedStagingHosts: domainConvergence.reportedHosts,
          preferredStagingDomainConverged: domainConvergence.converged,
          probeCandidates,
          checkedProbeCandidates: stagingProbeResult.checkedCandidates,
          stagingContentProbe: stagingProbeResult.probe,
          contentSyncReason: freshInstallDetected
            ? "fresh_install_detected"
            : (probeUnavailable ? "probe_failed" : "not_required"),
          capability: capabilityAfterExistingCheck,
          autoContentSync
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
        preferredStagingUrl: preferredStagingDomain,
        preferredStagingDomainConverged: domainConvergence.converged,
        reportedStagingHosts: domainConvergence.reportedHosts,
        stagingDomainApplied,
        stagingDeployTriggered,
        stagingRunning: currentStagingRunning,
        stagingContentProbe: stagingProbeResult.probe,
        actionHint: mergeActionHints(
          requiresContentSync && !autoContentSync.ok
          ? (freshInstallDetected
            ? "Staging appears to be a fresh install. Automatic content sync did not complete. Retry content sync from Operations."
            : "Staging content could not be verified, so Jongo attempted a conservative sync fallback. Retry content sync from Operations if redirects persist.")
          : currentStagingRunning
            ? null
            : `Staging ${targetLabel} is attached and still coming online. Refresh in a moment.`,
          preferredDomainPendingHint
        ),
        message: currentStagingRunning
          ? `Staging ${targetLabel} is already detected.`
          : `Staging ${targetLabel} is detected and still coming online. Refresh in a moment.`,
        autoContentSync,
        capability: capabilityAfterExistingCheck
      });
    }

    const preferredStagingDomain = await deriveCoolifyStagingDomainFromProduction(appUuid, {
      siteSlug: temporaryDomainSlug ?? site.slug ?? site.id,
      siteName: site.name
    });
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
    let stagingDeployTriggered = false;

    if (preferredStagingDomain && capabilityAfterProvision.applicationUuid) {
      if (capabilityAfterProvision.resourceKind === "service") {
        const pipeline = new StagingProvisioningPipeline({
          serviceUuid: capabilityAfterProvision.applicationUuid,
          desiredDomain: preferredStagingDomain
        });
        const result = await pipeline.execute();
        stagingDomainApplied = result.success;
        stagingDeployTriggered = result.success;
      } else if (capabilityAfterProvision.resourceKind === "application") {
        stagingDomainApplied = await applyCoolifyApplicationDomain(
          capabilityAfterProvision.applicationUuid,
          preferredStagingDomain
        );
        try {
          await triggerCoolifyDeploy(capabilityAfterProvision.applicationUuid, "staging");
          stagingDeployTriggered = true;
        } catch { }
      }
    }

    if (capabilityAfterProvision.applicationUuid && capabilityAfterProvision.status !== "healthy" && !stagingDeployTriggered) {
      try {
        await triggerCoolifyDeploy(capabilityAfterProvision.applicationUuid, "staging");
        stagingDeployTriggered = true;
        const refreshedCapability = await getCoolifyAppStagingCapability(appUuid, projectId);
        capabilityAfterProvision = refreshedCapability;
      } catch { }
    }

    const targetLabel = stagingTargetLabel(capabilityAfterProvision?.resourceKind);
    const manualProvisionRequired = !stagingTargetResolved;
    const stagingRunning = capabilityAfterProvision.status === "healthy";
    const createdNewService = provisionResult.reason === "service_created" || provisionResult.reason === "request_sent";
    const environmentOnlyProvisioned = provisionResult.reason === "environment_created";
    
    const requestBaseUrl = (() => {
      try {
        return new URL(req.url).origin;
      } catch {
        return process.env.APP_BASE_URL || "";
      }
    })();
    
    const domainConvergence = buildPreferredDomainConvergence({
      preferredStagingDomain,
      capabilityFqdn: capabilityAfterProvision.fqdn,
      capabilityStagingUrl: capabilityAfterProvision.stagingUrl
    });
    
    const preferredDomainPendingHint = preferredStagingDomain && !domainConvergence.converged
      ? `Preferred staging URL ${preferredStagingDomain} is not active yet. Coolify is still serving ${domainConvergence.reportedHosts[0] ? `https://${domainConvergence.reportedHosts[0]}` : "a generated staging host"}.`
      : null;
      
    const probeCandidates = buildStagingProbeCandidates({
      preferredStagingDomain,
      stagingUrl: capabilityAfterProvision.stagingUrl,
      fqdn: capabilityAfterProvision.fqdn
    });
    const stagingProbeResult = await probeStagingContentAcrossCandidates(probeCandidates);
    const freshInstallDetected = stagingProbeResult.probe.freshInstallDetected;
    const probeUnavailable = !stagingProbeResult.probe.checked;
    const requiresContentSync = createdNewService || freshInstallDetected || probeUnavailable;
    const contentSyncReason = createdNewService
      ? "service_created"
      : (freshInstallDetected ? "fresh_install_detected" : (probeUnavailable ? "probe_failed" : "not_required"));

    const autoSyncStagingUrl = (
      stagingProbeResult.matchedCandidate ||
      preferredStagingDomain ||
      capabilityAfterProvision.stagingUrl ||
      capabilityAfterProvision.fqdn?.split(",")[0]?.trim() ||
      ""
    ).trim();

    let autoContentSync: AutoContentSyncResult = {
      attempted: false,
      ok: false,
      reason: "not_required",
      message: "Automatic content sync not required."
    };

    if (requiresContentSync && capabilityAfterProvision.applicationUuid) {
      autoContentSync = await runAutoContentSync({
        siteId: site.id,
        productionServiceUuid: appUuid,
        stagingServiceUuid: capabilityAfterProvision.applicationUuid,
        stagingUrl: autoSyncStagingUrl,
        requestBaseUrl,
        direction: "production-to-staging"
      });
    }

    await tryRecordStagingAuditLog({
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
        preferredStagingHost: domainConvergence.preferredHost ?? null,
        reportedStagingHosts: domainConvergence.reportedHosts,
        preferredStagingDomainConverged: domainConvergence.converged,
        probeCandidates,
        checkedProbeCandidates: stagingProbeResult.checkedCandidates,
        stagingContentProbe: stagingProbeResult.probe,
        capability: capabilityAfterProvision,
        provisioningMessage: provisionResult.message,
        contentSyncReason,
        autoContentSync
      },
      req
    });

    const actionHint = mergeActionHints(
      manualProvisionRequired
      ? (provisionResult.ok
        ? (environmentOnlyProvisioned
          ? "Staging is being provisioned in Coolify. Check the Staging tab in a few minutes."
          : "Check the Staging tab in Coolify and refresh in a few minutes.")
          : "Check the Staging tab in Coolify and refresh in a few minutes.")
      : requiresContentSync
        ? (autoContentSync.ok
          ? "Staging content sync completed automatically. Refresh in a moment."
          : freshInstallDetected
            ? "Staging appears as a fresh install. Automatic content sync did not complete. Retry content sync from Operations."
            : "Staging content could not be verified. Automatic content sync did not complete. Retry content sync from Operations.")
      : !stagingRunning
        ? `Staging ${targetLabel} is attached and still coming online. Refresh in a moment.`
      : null,
      preferredDomainPendingHint
    );
    const enableMessage = manualProvisionRequired
      ? (provisionResult.ok
        ? (environmentOnlyProvisioned
          ? "Staging is being provisioned in Coolify. Check the Staging tab in a few minutes."
          : "Staging is being provisioned in Coolify. Check the Staging tab in a few minutes.")
          : "Staging is enabled in Jongo, but automatic provisioning is unavailable for this app. Check the Staging tab in Coolify.")
      : (requiresContentSync && autoContentSync.ok)
        ? "Staging content sync completed automatically."
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
      preferredStagingUrl: preferredStagingDomain,
      preferredStagingDomainConverged: domainConvergence.converged,
      reportedStagingHosts: domainConvergence.reportedHosts,
      stagingDomainApplied,
      stagingDeployTriggered,
      stagingRunning,
      stagingContentProbe: stagingProbeResult.probe,
      autoContentSync,
      message: enableMessage,
      capability: capabilityAfterProvision
    });
  }

  let destroyResult: { ok: boolean; message: string } | null = null;
  let destroyEnvironmentResult: { ok: boolean; message: string; reason?: string } | null = null;
  let capability = null as Awaited<ReturnType<typeof getCoolifyAppStagingCapability>> | null;
  let destroyedTargetCount = 0;

  await db.site.update({
    where: { id: site.id },
    data: { stagingEnabled: false },
    select: { id: true }
  });

  if (appUuid) {
    try {
      capability = await getCoolifyAppStagingCapability(
        appUuid,
        projectId,
        { relaxedTargetMatch: Boolean(body.burnExisting) }
      );
    } catch {
      capability = null;
    }
    const shouldDestroy = Boolean(body.burnExisting) && Boolean(capability?.detected && capability?.applicationUuid);
    if (shouldDestroy && capability?.applicationUuid) {
      try {
        let lastDestroyMessage = "Staging target is no longer attached in Coolify.";
        let cleanupFailed = false;

        for (let attempt = 0; attempt < 5; attempt += 1) {
          const activeCapability = attempt === 0
            ? capability
            : await getCoolifyAppStagingCapability(
                appUuid,
                projectId,
                { relaxedTargetMatch: Boolean(body.burnExisting) }
              );

          if (!activeCapability?.applicationUuid) {
            break;
          }

          const result = await destroyCoolifyApplication(activeCapability.applicationUuid, activeCapability.resourceKind);
          lastDestroyMessage = result.message;

          if (!result.ok) {
            cleanupFailed = true;
            break;
          }

          destroyedTargetCount += 1;
          await sleep(500);
        }

        const afterDestroyProbe = await getCoolifyAppStagingCapability(
          appUuid,
          projectId,
          { relaxedTargetMatch: Boolean(body.burnExisting) }
        );

        if (!afterDestroyProbe.applicationUuid) {
          destroyResult = {
            ok: true,
            message: destroyedTargetCount > 1
              ? `Removed ${destroyedTargetCount} staging targets in Coolify.`
              : destroyedTargetCount === 1
                ? "Staging target removed in Coolify."
                : "Staging target is no longer attached in Coolify."
          };
        } else {
          destroyResult = {
            ok: false,
            message: cleanupFailed
              ? lastDestroyMessage
              : "Some staging targets are still attached in Coolify and require manual cleanup."
          };
          capability = afterDestroyProbe;
        }
      } catch {
        destroyResult = {
          ok: false,
          message: "Staging target cleanup could not be verified automatically."
        };
      }
    }

    if (Boolean(body.burnExisting) && projectId) {
      try {
        const environmentResult = await deleteCoolifyStagingEnvironment(projectId);
        destroyEnvironmentResult = {
          ok: environmentResult.ok,
          message: environmentResult.message,
          reason: environmentResult.reason
        };
      } catch {
        destroyEnvironmentResult = {
          ok: false,
          message: "Staging environment cleanup could not be verified automatically.",
          reason: "auto_provision_unsupported"
        };
      }
    }
  }

  const environmentDestroyed = destroyEnvironmentResult?.reason === "environment_deleted";
  const destroyed = Boolean(destroyResult?.ok || environmentDestroyed);
  const destroyActionType = destroyed ? "staging_disable_destroy" : "staging_disable_requested";

  await tryRecordStagingAuditLog({
    organizationId: site.organizationId,
    actorId,
    actionType: destroyActionType,
    resourceId: site.id,
    details: {
      enabled: false,
      appUuid: appUuid || null,
      stagedDetected: Boolean(capability?.detected),
      destroyed,
      destroyedTargetCount,
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
  } catch (error) {
    console.error("POST /api/sites/[siteId]/staging error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const bootstrapGlobalAccess = hasBootstrapGlobalAccess(session);

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
    where: bootstrapGlobalAccess
      ? {
          ...buildSiteIdentityWhere(siteId)
        }
      : {
          ...buildSiteIdentityWhere(siteId),
          OR: [
            {
              organization: {
                deletedAt: null,
                OR: [
                  { ownerId: session.user.id },
                  { collaborators: { some: { userId: session.user.id, deletedAt: null } } }
                ]
              }
            },
            { collaborators: { some: { userId: session.user.id, deletedAt: null } } }
          ]
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
  const callerIsAdmin = bootstrapGlobalAccess || callerIsOwner || isAdminRole(site.organization.collaborators[0]?.role);
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

  const generatedRequests = requestedDomains.filter((domain) =>
    isGeneratedCoolifyHost(domain, capability.applicationUuid)
  );
  if (generatedRequests.length > 0) {
    return NextResponse.json({
      error: "Refusing to set a Coolify-generated host as a preferred domain. "
        + "It would be written into WordPress siteurl/home on the next content sync and pin the site to it.",
      domains: generatedRequests
    }, { status: 400 });
  }

  const isService = capability.resourceKind === "service";
  const serviceResult = isService
    ? await applyCoolifyServiceDomains(capability.applicationUuid, requestedDomains)
    : null;

  // Non-service resources still use the legacy boolean path.
  const applicationUpdated = !isService
    ? await applyCoolifyApplicationDomains(capability.applicationUuid, requestedDomains)
    : false;

  const updated = isService ? Boolean(serviceResult?.ok) : applicationUpdated;

  const compatibilityRetry = !updated
    ? await retryCoolifyDomainSyncWithDiagnostics({
        resourceKind: capability.resourceKind,
        resourceUuid: capability.applicationUuid,
        domains: requestedDomains
      })
    : { ok: true, message: "Staging domains updated." };
  const domainUpdateSucceeded = updated || compatibilityRetry.ok;
  const domainUpdateMessage = domainUpdateSucceeded
    ? (updated ? "Staging domains updated." : "Staging domains updated using compatibility mode.")
    : (serviceResult && !serviceResult.ok ? serviceResult.message : compatibilityRetry.message);

  // A domain change is inert at the edge until Coolify regenerates Traefik
  // labels, which only happens on deploy – restarting the WordPress container
  // directly does not do it.
  //
  // The restart is queued by Coolify, so the read-back below confirms only that
  // Coolify stored the preferred fqdn, not that Traefik is already serving it.
  // That is enough to gate content sync, which is what pins the wrong host.
  let restarted = false;
  let convergedDomains: string[] = [];
  let preferredDomainConverged = false;

  if (domainUpdateSucceeded && isService) {
    const restartResponse = await restartCoolifyService(capability.applicationUuid);
    restarted = restartResponse.ok;

    convergedDomains = await readCoolifyServiceDomains(capability.applicationUuid);
    const convergedHosts = new Set(
      convergedDomains.map((domain) => normalizeHostForCompare(domain)).filter(Boolean)
    );
    preferredDomainConverged = requestedDomains.every((domain) =>
      convergedHosts.has(normalizeHostForCompare(domain))
    );
  }

  await recordStagingAuditLog({
    organizationId: site.organizationId,
    actorId: session.user.id,
    actionType: domainUpdateSucceeded ? "staging_domains_updated" : "staging_domains_update_failed",
    resourceId: site.id,
    details: {
      domains: requestedDomains,
      stagingApplicationUuid: capability.applicationUuid,
      updated: domainUpdateSucceeded,
      compatibilityModeUsed: !updated && compatibilityRetry.ok,
      coolifyStatus: serviceResult?.status ?? compatibilityRetry.status ?? null,
      coolifyConflicts: serviceResult?.conflicts ?? null,
      restarted,
      reportedStagingHosts: convergedDomains,
      preferredStagingDomainConverged: preferredDomainConverged,
      message: domainUpdateMessage
    },
    req
  });

  if (!domainUpdateSucceeded) {
    return NextResponse.json({
      ok: false,
      stagingApplicationUuid: capability.applicationUuid,
      requestedDomains,
      coolifyStatus: serviceResult?.status ?? compatibilityRetry.status ?? null,
      conflicts: serviceResult?.conflicts ?? null,
      message: domainUpdateMessage
    }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    stagingApplicationUuid: capability.applicationUuid,
    requestedDomains,
    restarted,
    reportedStagingHosts: convergedDomains,
    preferredStagingDomainConverged: preferredDomainConverged,
    message: preferredDomainConverged
      ? domainUpdateMessage
      : `${domainUpdateMessage} Coolify has not reported the preferred host yet; `
        + "do not run a content sync until it converges or the generated host will be written into WordPress.",
    warning: preferredDomainConverged ? undefined : "preferred_domain_not_converged"
  });
}
