import { recordCoolifyEndpointCall, recordCoolifyInventoryResult } from "@/lib/diagnostics";
import { deriveStageDomain, parsePlatformSuffixes } from "@/lib/stage-domain";
import { buildWordPressServiceRequest, type WordPressProvisionInput } from "@/lib/wordpress-provision";
import { detectResourceType } from "./resource-types";
import { resolveStagingServerUuid } from "./coolify-server-resolve";
import { detectDatabaseEnv } from "./database-env-detect";
import { extractResourceDomains } from "./coolify-primary-domain";
import { CoolifyRateLimitError, CoolifyHttpError, isNotFoundError, isRateLimitError } from "./coolify-rate-limit";
import { deployRequestPlan, deployRetryDelaySeconds, isRetryableDeployStatus } from "./coolify-deploy-plan";
import { CoolifyMutateResponse, CoolifyProjectRecord, SiteOverview, SiteType, coolifyFetch, coolifyMutate, coolifyMutateWithResponse, ensureArray, estimateResponseCount, extractCoolifyDomainCandidates, extractStagingDomainList, normalizeArrayPayload, normalizeCoolifyDomains, normalizeProjectRecords, statusFromRaw, stringValue, toHttpsUrl } from "./coolify-core";
export { isGeneratedCoolifyHost } from "./coolify-host";
// Split into lib/coolify-core.ts, coolify-backups.ts, coolify-staging-capability.ts and
// coolify-staging-provision.ts; re-exported here so imports stay "@/lib/coolify".
export { type CoolifyActionResult, type CoolifyMutateResponse, type CoolifyProjectRecord, type SiteOverview, type SiteType, coolifyFetch, coolifyMutate, coolifyMutateWithResponse } from "./coolify-core";
export { type StagingCapabilityRecord, type StagingSyncPlan, getCoolifyAppStagingCapability, buildStagingSyncDryRunPlan } from "./coolify-staging-capability";
export { type BackupScheduleRecord, type BackupExecutionRecord, type DatabaseBackupCoverageRecord, type AppBackupInventory, type BackupScheduleProvisionResult, ensureCoolifyAppBackupSchedules, getCoolifyAppBackupInventory } from "./coolify-backups";
export { ensureCoolifyStagingEnvironment, deleteCoolifyStagingEnvironment, provisionCoolifyStagingFromProduction, destroyCoolifyApplication } from "./coolify-staging-provision";

export type DeploymentRecord = {
  id: string;
  siteName: string;
  environment: "production" | "staging" | "unknown";
  status: "healthy" | "degraded" | "error" | "unknown";
  finishedAt?: string;
  startedAt?: string;
  commitMessage?: string;
  durationSeconds?: number;
};

export type CoolifyEnvironmentRecord = {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
};

export type CoolifyOverview = {
  mode: "live" | "mock";
  generatedAt: string;
  /** Present when the Coolify API was reachable but the fetch threw or returned empty unexpectedly. */
  fetchError?: string;
  projects: CoolifyProjectRecord[];
  environments: CoolifyEnvironmentRecord[];
  sites: SiteOverview[];
  deployments: DeploymentRecord[];
  stats: {
    healthySites: number;
    degradedSites: number;
    errorSites: number;
    unknownSites: number;
  };
};

export type CoolifyConnectionStatus = {
  mode: "live" | "mock";
  configured: boolean;
  reachable: boolean;
  baseUrl?: string;
  applicationCount: number;
  checkedAt: string;
  error?: string;
};

type CoolifyOverviewCacheState = {
  value?: CoolifyOverview;
  cachedAtMs: number;
  inFlight?: Promise<CoolifyOverview>;
};

const overviewCache: CoolifyOverviewCacheState = {
  cachedAtMs: 0
};

/**
 * Detect site type from Coolify resource metadata using centralized
 * resource-type detection, then map to workspace-facing site types.
 */
export function detectSiteType(resource: Record<string, unknown>): SiteType {
  const resourceType = detectResourceType(resource).type;

  if (resourceType === "WordPress") return "wordpress";
  if (resourceType === "Database") return "database";
  if (resourceType === "Service") return "service";

  return "generic";
}

function partitionResourceInventory(resources: Record<string, unknown>[]): {
  applications: Record<string, unknown>[];
  services: Record<string, unknown>[];
  databases: Record<string, unknown>[];
} {
  const applications: Record<string, unknown>[] = [];
  const services: Record<string, unknown>[] = [];
  const databases: Record<string, unknown>[] = [];

  for (const resource of resources) {
    const detectedType = detectResourceType(resource).type;
    const type = stringValue(resource, ["resource_type", "type", "kind", "service_type"]).toLowerCase();
    const engine = stringValue(resource, ["database_type", "engine", "db_type"]).toLowerCase();
    const image = stringValue(resource, ["image", "docker_image", "container_image", "name", "custom_type"]).toLowerCase();
    const hasCompose = typeof resource.docker_compose === "string" || typeof resource.docker_compose_raw === "string";
    const hasGitRepo = typeof resource.git_repository === "string";

    if (
      detectedType === "Database" ||
      type.includes("database") ||
      type.includes("postgres") ||
      type.includes("mysql") ||
      type.includes("mariadb") ||
      type.includes("redis") ||
      image.includes("postgres") ||
      image.includes("mysql") ||
      image.includes("mariadb") ||
      engine.length > 0
    ) {
      databases.push(resource);
      continue;
    }

    if (detectedType === "Service" || type.includes("service") || hasCompose) {
      services.push(resource);
      continue;
    }

    if (detectedType === "WordPress" || detectedType === "Web App" || type.includes("application") || hasGitRepo) {
      applications.push(resource);
      continue;
    }

    // Keep unknown resource types visible in inventory by classifying them as generic services.
    services.push(resource);
  }

  return { applications, services, databases };
}

function extractComposeLabelValue(raw: unknown, labelKey: string): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) {
    return undefined;
  }

  const pattern = new RegExp(`${labelKey}=?([^\\n\"\r]+)`, "i");
  const match = raw.match(pattern);
  if (!match?.[1]) {
    return undefined;
  }

  return match[1].trim();
}

function resolveProjectForResource(
  resource: Record<string, unknown>,
  projectsById: Map<string, CoolifyProjectRecord>,
  projectsByName: Map<string, CoolifyProjectRecord>,
  environmentById: Map<string, CoolifyEnvironmentRecord>,
  environmentByName: Map<string, CoolifyEnvironmentRecord>
): { id?: string; name?: string; environmentId?: string; environmentName?: string } {
  const idCandidates = new Set<string>();
  const nameCandidates = new Set<string>();
  const rawNameCandidates = new Set<string>();
  const environmentIdCandidates = new Set<string>();
  const environmentNameCandidates = new Set<string>();

  const directId = stringValue(resource, ["project_uuid", "project_id", "projectId"], "");
  if (directId) idCandidates.add(directId);

  const environmentId = stringValue(resource, ["environment_id", "environmentId", "environment_uuid"], "");
  if (environmentId) {
    environmentIdCandidates.add(environmentId);
  }

  const environmentValue = resource.environment;
  if (typeof environmentValue === "string") {
    environmentIdCandidates.add(environmentValue);
  } else if (typeof environmentValue === "object" && environmentValue !== null) {
    const envObj = environmentValue as Record<string, unknown>;
    const envId = stringValue(envObj, ["id", "uuid", "environment_id"], "");
    const envName = stringValue(envObj, ["name", "environment_name"], "");
    if (envId) environmentIdCandidates.add(envId);
    if (envName) environmentNameCandidates.add(envName.trim().toLowerCase());
  }

  const projectValue = resource.project;
  if (typeof projectValue === "string") {
    idCandidates.add(projectValue);
    nameCandidates.add(projectValue.trim().toLowerCase());
    rawNameCandidates.add(projectValue.trim());
  } else if (typeof projectValue === "object" && projectValue !== null) {
    const projectObj = projectValue as Record<string, unknown>;
    const nestedId = stringValue(projectObj, ["uuid", "id", "project_uuid", "project_id"], "");
    const nestedName = stringValue(projectObj, ["name", "project_name", "display_name"], "");
    if (nestedId) idCandidates.add(nestedId);
    if (nestedName) {
      nameCandidates.add(nestedName.trim().toLowerCase());
      rawNameCandidates.add(nestedName.trim());
    }
  }

  const directName = stringValue(resource, ["project_name"], "");
  if (directName) {
    nameCandidates.add(directName.trim().toLowerCase());
    rawNameCandidates.add(directName.trim());
  }

  const composeProjectName =
    extractComposeLabelValue(resource.docker_compose, "coolify.projectName") ??
    extractComposeLabelValue(resource.docker_compose_raw, "coolify.projectName") ??
    extractComposeLabelValue(resource.custom_labels, "coolify.projectName");
  if (composeProjectName) {
    nameCandidates.add(composeProjectName.toLowerCase());
    rawNameCandidates.add(composeProjectName);
  }

  const composeEnvironmentName =
    extractComposeLabelValue(resource.docker_compose, "coolify.environmentName") ??
    extractComposeLabelValue(resource.docker_compose_raw, "coolify.environmentName") ??
    extractComposeLabelValue(resource.custom_labels, "coolify.environmentName");
  if (composeEnvironmentName) {
    environmentNameCandidates.add(composeEnvironmentName.toLowerCase());
  }

  for (const candidate of environmentIdCandidates) {
    const environment = environmentById.get(candidate);
    if (environment) {
      return {
        id: environment.projectId,
        name: environment.projectName,
        environmentId: environment.id,
        environmentName: environment.name
      };
    }
  }

  for (const candidate of environmentNameCandidates) {
    const environment = environmentByName.get(candidate);
    if (environment) {
      return {
        id: environment.projectId,
        name: environment.projectName,
        environmentId: environment.id,
        environmentName: environment.name
      };
    }
  }

  for (const candidate of idCandidates) {
    const project = projectsById.get(candidate);
    if (project) {
      return { id: project.id, name: project.name };
    }
  }

  for (const candidate of nameCandidates) {
    const project = projectsByName.get(candidate);
    if (project) {
      return { id: project.id, name: project.name };
    }
  }

  const fallbackId = [...idCandidates][0];
  const fallbackName = [...rawNameCandidates][0];
  const fallbackEnvironmentId = [...environmentIdCandidates][0];
  const fallbackEnvironmentName = [...environmentNameCandidates][0];
  return {
    id: fallbackId,
    name: fallbackName,
    environmentId: fallbackEnvironmentId,
    environmentName: fallbackEnvironmentName
  };
}

function combineStatuses(...statuses: SiteOverview["status"][]): SiteOverview["status"] {
  if (statuses.includes("error")) return "error";
  if (statuses.includes("degraded")) return "degraded";
  if (statuses.includes("healthy")) return "healthy";
  return "unknown";
}

function deploymentEnvironmentFromRaw(deployment: Record<string, unknown>): DeploymentRecord["environment"] {
  const environmentRaw = stringValue(
    deployment,
    ["environment", "environment_name", "branch", "git_branch", "target", "deployment_url", "preview_url"],
    ""
  ).toLowerCase();

  if (!environmentRaw) {
    return "production";
  }

  if (environmentRaw.includes("stag") || environmentRaw.includes("preview") || environmentRaw.includes("dev")) {
    return "staging";
  }

  if (environmentRaw.includes("prod") || environmentRaw.includes("main") || environmentRaw.includes("live")) {
    return "production";
  }

  return "production";
}

function deploymentStatusFromRaw(deployment: Record<string, unknown>): DeploymentRecord["status"] {
  const explicitStatus = statusFromRaw(
    deployment.status ?? deployment.result ?? deployment.current_status ?? deployment.state ?? deployment.server_status
  );

  if (explicitStatus !== "unknown") {
    return explicitStatus;
  }

  const finishedAt = stringValue(deployment, ["finished_at", "updated_at"], "");
  const startedAt = stringValue(deployment, ["started_at", "queued_at", "created_at"], "");

  if (finishedAt) {
    return "healthy";
  }

  if (startedAt) {
    return "degraded";
  }

  return "unknown";
}

function normalizeDeploymentRecords(input: unknown, fallbackSiteName = "Unknown Service"): DeploymentRecord[] {
  return normalizeArrayPayload(input).map((deployment, index): DeploymentRecord => {
    const id = stringValue(deployment, ["uuid", "id"], `dep-${index + 1}`);
    const siteName = stringValue(deployment, ["service_name", "name", "application_name"], fallbackSiteName);

    const finishedAt = stringValue(deployment, ["finished_at", "updated_at", "created_at"], "") || undefined;
    const startedAt = stringValue(deployment, ["started_at", "queued_at", "created_at"], "") || undefined;
    const commitMessage = stringValue(deployment, ["commit_message", "message", "description"], "") || undefined;

    let durationSeconds: number | undefined;
    if (startedAt && finishedAt) {
      const diff = (new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000;
      if (diff > 0) durationSeconds = Math.round(diff);
    }

    return {
      id,
      siteName,
      environment: deploymentEnvironmentFromRaw(deployment),
      status: deploymentStatusFromRaw(deployment),
      finishedAt,
      startedAt,
      commitMessage,
      durationSeconds
    };
  });
}

/** Every project Coolify currently has, for cross-referencing against which ones have no linked Organization yet. */
export async function listCoolifyProjects(): Promise<CoolifyProjectRecord[]> {
  const projectsPayload = await coolifyFetch("/api/v1/projects");
  return normalizeProjectRecords(projectsPayload);
}

/**
 * What the overview reports when hosting credentials are not configured: no
 * projects, no sites, flagged "mock" so the UI says hosting isn't connected.
 * It used to return two invented clients with invented sites and deploys,
 * which a misconfigured install showed as if they were real.
 */
function unconfiguredOverview(): CoolifyOverview {
  return { ...emptyLiveOverview(), mode: "mock" };
}

function emptyLiveOverview(): CoolifyOverview {
  return {
    mode: "live",
    generatedAt: new Date().toISOString(),
    projects: [],
    environments: [],
    sites: [],
    deployments: [],
    stats: {
      healthySites: 0,
      degradedSites: 0,
      errorSites: 0,
      unknownSites: 0
    }
  };
}

async function readApplicationDeployments(applicationId: string, fallbackSiteName: string, limit = 8): Promise<DeploymentRecord[]> {
  try {
    const payload = await coolifyFetch(`/api/v1/deployments/applications/${applicationId}?take=${limit}`);
    return normalizeDeploymentRecords(payload, fallbackSiteName).slice(0, limit);
  } catch {
    return [];
  }
}

function sortDeploymentsNewestFirst(deployments: DeploymentRecord[]): DeploymentRecord[] {
  return [...deployments].sort((left, right) => {
    const rightTime = right.finishedAt ? new Date(right.finishedAt).getTime() : 0;
    const leftTime = left.finishedAt ? new Date(left.finishedAt).getTime() : 0;
    return rightTime - leftTime;
  });
}

function makeSiteOverview(
  resource: Record<string, unknown>,
  fallbackName: string,
  fallbackId: string,
  projectsById: Map<string, CoolifyProjectRecord>,
  projectsByName: Map<string, CoolifyProjectRecord>,
  environmentById: Map<string, CoolifyEnvironmentRecord>,
  environmentByName: Map<string, CoolifyEnvironmentRecord>
): SiteOverview {
  const id = stringValue(resource, ["uuid", "id"], fallbackId);
  const name = stringValue(resource, ["name", "application_name", "service_name"], fallbackName);
  const productionStatus = statusFromRaw(resource.production_status ?? resource.status ?? resource.current_status ?? resource.state ?? resource.server_status);
  const stagingStatus = statusFromRaw(resource.staging_status ?? resource.preview_status);
  const project = resolveProjectForResource(resource, projectsById, projectsByName, environmentById, environmentByName);
    const resourceTypeMetadata = detectResourceType(resource);
  const domains = extractResourceDomains(resource);

  return {
    id,
    deployTargetId: id,
    name,
    status: combineStatuses(productionStatus, stagingStatus),
    productionStatus,
    stagingStatus,
    siteType: detectSiteType(resource),
    coolifyProjectId: project.id,
    coolifyProjectName: project.name,
    coolifyEnvironmentId: project.environmentId,
    coolifyEnvironmentName: project.environmentName,
    resourceType: resourceTypeMetadata.type,
    // Read from the resource payload the overview already fetched, so showing
    // the real domain costs no additional Coolify call — this page render used
    // to be the thing tripping the API rate limit.
    primaryDomain: domains[0] ?? undefined,
    domains: domains.length > 0 ? domains : undefined
  };
}

async function readProjectEnvironments(projects: CoolifyProjectRecord[]): Promise<CoolifyEnvironmentRecord[]> {
  const envs: CoolifyEnvironmentRecord[] = [];

  for (const project of projects) {
    try {
      const payload = await coolifyFetch(`/api/v1/projects/${project.id}`);
      const projectObject = Array.isArray(payload) ? payload[0] : payload;

      if (!projectObject || typeof projectObject !== "object") {
        continue;
      }

      const environments = ensureArray((projectObject as Record<string, unknown>).environments);
      for (const environment of environments) {
        const envId = stringValue(environment, ["id", "uuid", "environment_id"], "");
        const envName = stringValue(environment, ["name", "environment_name"], envId || "environment");
        if (!envId) {
          continue;
        }

        envs.push({
          id: envId,
          name: envName,
          projectId: project.id,
          projectName: project.name
        });
      }
    } catch {
      // Keep going; environments are best-effort diagnostics and ownership hints.
    }
  }

  return envs;
}

function buildSiteStats(sites: SiteOverview[]) {
  return {
    healthySites: sites.filter((site) => site.status === "healthy").length,
    degradedSites: sites.filter((site) => site.status === "degraded").length,
    errorSites: sites.filter((site) => site.status === "error").length,
    unknownSites: sites.filter((site) => site.status === "unknown").length
  };
}

async function buildLiveOverview(
  applications: Record<string, unknown>[],
  services: Record<string, unknown>[],
  databases: Record<string, unknown>[],
  projects: CoolifyProjectRecord[],
  environments: CoolifyEnvironmentRecord[]
): Promise<CoolifyOverview> {
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  for (const project of projects) {
    if (project.numericId) {
      projectsById.set(project.numericId, project);
    }
  }
  const projectsByName = new Map(projects.map((project) => [project.name.trim().toLowerCase(), project]));
  const environmentById = new Map<string, CoolifyEnvironmentRecord>();
  const environmentByName = new Map<string, CoolifyEnvironmentRecord>();
  for (const environment of environments) {
    environmentById.set(environment.id, environment);
    environmentByName.set(environment.name.trim().toLowerCase(), environment);
  }

  const serviceChildApplicationIds = new Set<string>();
  const serviceChildDatabaseIds = new Set<string>();

  for (const service of services) {
    for (const application of ensureArray(service.applications)) {
      const applicationId = stringValue(application, ["uuid", "id"]);
      if (applicationId) {
        serviceChildApplicationIds.add(applicationId);
      }
    }

    for (const database of ensureArray(service.databases)) {
      const databaseId = stringValue(database, ["uuid", "id"]);
      if (databaseId) {
        serviceChildDatabaseIds.add(databaseId);
      }
    }
  }

  const standaloneApplications = applications.filter((application) => {
    const id = stringValue(application, ["uuid", "id"]);
    return !id || !serviceChildApplicationIds.has(id);
  });

  const standaloneDatabases = databases.filter((database) => {
    const id = stringValue(database, ["uuid", "id"]);
    return !id || !serviceChildDatabaseIds.has(id);
  });

  const deploymentSampleLimit = Math.max(0, Math.min(Number(process.env.COOLIFY_DEPLOYMENT_SAMPLE_LIMIT ?? 8), 20));
  const applicationSitesWithDeployments = await Promise.all(
    standaloneApplications.slice(0, 20).map(async (application, index): Promise<{ site: SiteOverview; deployments: DeploymentRecord[] }> => {
      const site = makeSiteOverview(
        application,
        `application-${index + 1}`,
        `app-${index + 1}`,
        projectsById,
        projectsByName,
        environmentById,
        environmentByName
      );
      const shouldFetchDeployments = index < deploymentSampleLimit;
      const deployments = shouldFetchDeployments ? await readApplicationDeployments(site.id, site.name, 8) : [];
      const productionDeployment = deployments.find((deployment) => deployment.environment === "production");
      const stagingDeployment = deployments.find((deployment) => deployment.environment === "staging");

      return {
        site: {
          ...site,
          productionStatus: productionDeployment?.status ?? site.productionStatus,
          stagingStatus: stagingDeployment?.status ?? site.stagingStatus,
          status: combineStatuses(site.status, productionDeployment?.status ?? "unknown", stagingDeployment?.status ?? "unknown")
        },
        deployments
      };
    })
  );

  const serviceSites = services.map((service, index) =>
    makeSiteOverview(
      service,
      `service-${index + 1}`,
      `svc-${index + 1}`,
      projectsById,
      projectsByName,
      environmentById,
      environmentByName
    )
  );
  const databaseSites = standaloneDatabases.map((database, index) =>
    makeSiteOverview(
      database,
      `database-${index + 1}`,
      `db-${index + 1}`,
      projectsById,
      projectsByName,
      environmentById,
      environmentByName
    )
  );

  const sites = [
    ...applicationSitesWithDeployments.map((item) => item.site),
    ...serviceSites,
    ...databaseSites
  ];

  const deployments = sortDeploymentsNewestFirst(
    applicationSitesWithDeployments.flatMap((item) => item.deployments).slice(0, 12)
  );

  return {
    mode: "live",
    generatedAt: new Date().toISOString(),
    projects,
    environments,
    sites,
    deployments,
    stats: buildSiteStats(sites)
  };
}

function getOverviewCacheTtlMs(): number {
  const parsed = Number(process.env.COOLIFY_OVERVIEW_TTL_MS ?? 5000);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 5000;
  }

  return Math.min(parsed, 15000);
}

function readCachedOverview(nowMs: number): CoolifyOverview | undefined {
  if (!overviewCache.value) {
    return undefined;
  }

  const ttlMs = getOverviewCacheTtlMs();
  if (ttlMs <= 0) {
    return undefined;
  }

  if (nowMs - overviewCache.cachedAtMs > ttlMs) {
    return undefined;
  }

  return overviewCache.value;
}

function writeOverviewCache(value: CoolifyOverview) {
  overviewCache.value = value;
  overviewCache.cachedAtMs = Date.now();
}

async function fetchCoolifyOverviewFresh(): Promise<CoolifyOverview> {
  const baseUrl = process.env.COOLIFY_API_BASE_URL;
  const token = process.env.COOLIFY_API_TOKEN;

  if (!baseUrl || !token) {
    const overview = unconfiguredOverview();
    recordCoolifyInventoryResult({
      mode: "mock",
      source: "mock",
      success: false,
      sitesCount: overview.sites.length,
      deploymentsCount: overview.deployments.length,
      projectsCount: overview.projects.length,
      environmentsCount: overview.environments.length,
      note: "missing_coolify_env"
    });
    return overview;
  }

  try {
    let projects: CoolifyProjectRecord[] = [];
    try {
      const projectsPayload = await coolifyFetch("/api/v1/projects");
      projects = normalizeProjectRecords(projectsPayload);
    } catch {
      projects = [];
    }
    const environments = await readProjectEnvironments(projects);

    let applications: Record<string, unknown>[] = [];
    let services: Record<string, unknown>[] = [];
    let databases: Record<string, unknown>[] = [];
    let usedResourcesPrimary = false;
    let hadEndpointFailure = false;

    try {
      const resourcesPayload = await coolifyFetch("/api/v1/resources");
      const resources = normalizeArrayPayload(resourcesPayload);

      if (resources.length > 0) {
        const partitioned = partitionResourceInventory(resources);
        applications = partitioned.applications;
        services = partitioned.services;
        databases = partitioned.databases;
        usedResourcesPrimary = true;
      }
    } catch {
      usedResourcesPrimary = false;
      hadEndpointFailure = true;
    }

    if (!usedResourcesPrimary) {
      try {
        const applicationsPayload = await coolifyFetch("/api/v1/applications");
        applications = normalizeArrayPayload(applicationsPayload);
      } catch {
        hadEndpointFailure = true;
      }

      try {
        const servicesPayload = await coolifyFetch("/api/v1/services");
        services = normalizeArrayPayload(servicesPayload);
      } catch {
        hadEndpointFailure = true;
      }

      try {
        const databasesPayload = await coolifyFetch("/api/v1/databases");
        databases = normalizeArrayPayload(databasesPayload);
      } catch {
        hadEndpointFailure = true;
      }
    }

    if (applications.length > 0 || services.length > 0 || databases.length > 0) {
      const overview = await buildLiveOverview(applications, services, databases, projects, environments);
      recordCoolifyInventoryResult({
        mode: "live",
        source: "coolify",
        success: true,
        sitesCount: overview.sites.length,
        deploymentsCount: overview.deployments.length,
        projectsCount: overview.projects.length,
        environmentsCount: overview.environments.length,
        note: usedResourcesPrimary ? "live_inventory_non_empty_resources_primary" : "live_inventory_non_empty"
      });
      return overview;
    }

    const emptyOverview = {
      ...emptyLiveOverview(),
      projects,
      environments
    };
    recordCoolifyInventoryResult({
      mode: "live",
      source: "coolify",
      success: !hadEndpointFailure,
      sitesCount: emptyOverview.sites.length,
      deploymentsCount: emptyOverview.deployments.length,
      projectsCount: emptyOverview.projects.length,
      environmentsCount: emptyOverview.environments.length,
      note: hadEndpointFailure ? "live_inventory_empty_after_endpoint_failure" : "live_inventory_empty"
    });
    return hadEndpointFailure ? { ...emptyOverview, fetchError: "coolify_api_error" } : emptyOverview;
  } catch {
    const fallback = emptyLiveOverview();
    recordCoolifyInventoryResult({
      mode: "live",
      source: "coolify",
      success: false,
      sitesCount: fallback.sites.length,
      deploymentsCount: fallback.deployments.length,
      projectsCount: fallback.projects.length,
      environmentsCount: fallback.environments.length,
      note: "coolify_exception_empty_fallback"
    });
    return { ...fallback, fetchError: "coolify_api_error" };
  }
}

export async function getCoolifyOverview(): Promise<CoolifyOverview> {
  const nowMs = Date.now();
  const cached = readCachedOverview(nowMs);
  if (cached) {
    return cached;
  }

  if (overviewCache.inFlight) {
    return overviewCache.inFlight;
  }

  overviewCache.inFlight = fetchCoolifyOverviewFresh()
    .then((overview) => {
      writeOverviewCache(overview);
      return overview;
    })
    .finally(() => {
      overviewCache.inFlight = undefined;
    });

  return overviewCache.inFlight;
}

export async function getCoolifyConnectionStatus(): Promise<CoolifyConnectionStatus> {
  const baseUrl = process.env.COOLIFY_API_BASE_URL;
  const token = process.env.COOLIFY_API_TOKEN;
  const configured = Boolean(baseUrl && token);

  if (!configured) {
    return {
      mode: "mock",
      configured: false,
      reachable: false,
      baseUrl,
      applicationCount: 0,
      checkedAt: new Date().toISOString(),
      error: "Missing COOLIFY_API_BASE_URL or COOLIFY_API_TOKEN"
    };
  }

  try {
    const payload = await coolifyFetch("/api/v1/applications");
    const applications = normalizeArrayPayload(payload);

    return {
      mode: "live",
      configured: true,
      reachable: true,
      baseUrl,
      applicationCount: applications.length,
      checkedAt: new Date().toISOString()
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Coolify connectivity check failed";
    return {
      mode: "mock",
      configured: true,
      reachable: false,
      baseUrl,
      applicationCount: 0,
      checkedAt: new Date().toISOString(),
      error: message
    };
  }
}

export type DeployTriggerResult = {
  mode: "live";
  deploymentId: string;
  message: string;
  /**
   * "restart" for a service (WordPress): Coolify creates no deployment record,
   * and deploymentId is a placeholder that matches nothing. "deploy" queues a
   * real, trackable deployment.
   */
  action?: "restart" | "deploy";
  /** Coolify's deployment uuid when it returned one; null means it can't be followed. */
  trackableDeploymentId?: string | null;
};

function extractFirstHostLikeValue(raw: string): string | undefined {
  const tokens = raw
    .split(/[\s,;]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  return tokens[0];
}

function buildStagingDomainFromProductionUrl(productionRaw: string): string | undefined {
  const first = extractFirstHostLikeValue(productionRaw);
  if (!first) {
    return undefined;
  }

  const productionUrl = toHttpsUrl(first);
  if (!productionUrl) {
    return undefined;
  }

  const hostname = new URL(productionUrl).hostname;
  if (!hostname || hostname.startsWith("staging-") || hostname.startsWith("staging.")) {
    return undefined;
  }

  return `https://staging-${hostname}`;
}

function extractProductionDomainSlug(productionRaw: string): string | undefined {
  const first = extractFirstHostLikeValue(productionRaw);
  if (!first) {
    return undefined;
  }

  const productionUrl = toHttpsUrl(first);
  if (!productionUrl) {
    return undefined;
  }

  const hostname = new URL(productionUrl).hostname.toLowerCase();
  if (!hostname || hostname.startsWith("staging-") || hostname.startsWith("staging.")) {
    return undefined;
  }

  const labels = hostname.split(".").filter(Boolean);
  if (labels.length === 0) {
    return undefined;
  }

  // Ignore staging hostnames like <slug>.staging.example.com when deriving
  // the production slug, otherwise we can lock in a previously wrong slug.
  if (labels.includes("staging")) {
    return undefined;
  }

  const leading = labels[0] === "www" ? labels[1] ?? "" : labels[0];
  return normalizeDomainSlug(leading) || undefined;
}

function normalizeDomainSlug(value?: string | null): string {
  if (!value) {
    return "";
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized;
}

function looksAutoGeneratedDomainSlug(value: string): boolean {
  return /(?:wordpress|mysql|mariadb|service|app)(?:-[a-z0-9]+)*-[a-z0-9]{10,}$/i.test(value);
}

function hasLikelyCoolifySuffix(siteSlug: string, siteNameSlug?: string): boolean {
  if (!siteSlug) {
    return false;
  }

  // Common Coolify-style suffix fragments are 8-12 lowercase alnum chars.
  if (siteNameSlug && siteSlug.startsWith(`${siteNameSlug}-`)) {
    const tail = siteSlug.slice(siteNameSlug.length + 1);
    if (/^[a-z0-9]{8,12}$/.test(tail)) {
      return true;
    }
  }

  return /-[a-z0-9]{10,12}$/.test(siteSlug);
}

function normalizeDomainSuffix(value?: string): string {
  if (!value) {
    return "";
  }

  return value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .toLowerCase();
}

function deriveStagingDomainFromTemplate(options: {
  appUuid: string;
  siteSlug?: string | null;
  siteName?: string | null;
  domainSuffix?: string | null;
}): string | undefined {
  const slugFromSite = normalizeDomainSlug(options.siteSlug);
  const slugFromName = normalizeDomainSlug(options.siteName);
  const preferNameOverSite = Boolean(
    slugFromName &&
    slugFromSite &&
    hasLikelyCoolifySuffix(slugFromSite, slugFromName)
  );
  const slug = (
    (!preferNameOverSite && !looksAutoGeneratedDomainSlug(slugFromSite) && slugFromSite) ||
    slugFromName ||
    slugFromSite
  );
  if (!slug) {
    return undefined;
  }

  const template = (process.env.STAGING_DOMAIN_TEMPLATE || "").trim();
  if (template) {
    const fromTemplate = template
      .replace(/\{\s*slug\s*\}/gi, slug)
      .replace(/\{\s*appUuid\s*\}/gi, options.appUuid);
    return toHttpsUrl(fromTemplate);
  }

  const suffix = normalizeDomainSuffix(options.domainSuffix ?? process.env.STAGING_DOMAIN_SUFFIX);
  if (!suffix) {
    return undefined;
  }

  return toHttpsUrl(`${slug}.${suffix}`);
}

export async function deriveCoolifyStagingDomainFromProduction(
  appUuid: string,
  options?: { siteSlug?: string | null; siteName?: string | null; domainSuffix?: string | null }
): Promise<string | undefined> {
  try {
    // Prefer deterministic site metadata first so retries do not drift across
    // unrelated Coolify resource domains when API payloads contain noisy values.
    // Kept only as a LAST RESORT. It builds a hostname out of the Coolify
    // resource slug, which produced staging URLs like
    // wordpress-with-mariadb-<uuid>.staging.mfts.link — a name unrelated to the
    // site it belongs to. The staging URL should be the production domain with
    // a stage. prefix, so the production domains are consulted first below.
    const templateFallback = deriveStagingDomainFromTemplate({
      appUuid,
      siteSlug: options?.siteSlug,
      siteName: options?.siteName,
      domainSuffix: options?.domainSuffix
    });

    const candidates: string[] = [];

    const payloadLookups = [
      `/api/v1/applications/${encodeURIComponent(appUuid)}`,
      `/api/v1/services/${encodeURIComponent(appUuid)}`
    ];

    for (const path of payloadLookups) {
      try {
        const payload = await coolifyFetch(path);
        const resource = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;

        const directValues = [
          stringValue(resource, ["fqdn", "url", "domain", "domains", "preview_url", "production_url"], ""),
          ...extractCoolifyDomainCandidates(resource.fqdn),
          ...extractCoolifyDomainCandidates(resource.domain),
          ...extractCoolifyDomainCandidates(resource.domains),
          ...extractCoolifyDomainCandidates(resource.url),
          ...extractCoolifyDomainCandidates(resource.urls),
          ...extractCoolifyDomainCandidates(resource.production_url),
          ...extractCoolifyDomainCandidates(resource.preview_url)
        ];

        for (const value of directValues) {
          const domains = extractCoolifyDomainCandidates(value);
          if (domains.length > 0) {
            candidates.push(...domains);
            continue;
          }

          if (typeof value === "string" && value.trim().length > 0) {
            candidates.push(value.trim());
          }
        }

        for (const domainCandidate of extractCoolifyDomainCandidates(resource.urls)) {
          candidates.push(domainCandidate);
        }

        // Service payloads often carry production domains inside nested
        // applications/services arrays rather than top-level fields.
        for (const nestedDomain of extractStagingDomainList(resource)) {
          candidates.push(nestedDomain);
        }

        // A Coolify SERVICE keeps the site's real domain on its nested
        // application rows: service.fqdn is undefined while
        // service.applications[0].fqdn is "https://site.example.com". Every
        // WordPress stack here is a service, so missing this meant domain
        // derivation had nothing to work with and fell back to a slug
        // template — which is exactly how staging ended up named after the
        // Coolify resource instead of the site.
        for (const nestedKey of ["applications", "databases"]) {
          const nested = (resource as Record<string, unknown>)[nestedKey];
          if (!Array.isArray(nested)) continue;
          for (const entry of nested) {
            if (!entry || typeof entry !== "object") continue;
            const row = entry as Record<string, unknown>;
            for (const field of ["fqdn", "domains", "url", "urls"]) {
              const value = row[field];
              const extracted = extractCoolifyDomainCandidates(value);
              if (extracted.length > 0) {
                candidates.push(...extracted);
              } else if (typeof value === "string" && value.trim().length > 0) {
                candidates.push(value.trim());
              }
            }
          }
        }
      } catch {
        // Continue to next endpoint.
      }
    }

    // stage.{main production domain} — the format the platform actually wants.
    // Platform-controlled suffixes win because their DNS is wildcarded here, so
    // the staging URL resolves the instant it is created; prefixing a
    // customer's own domain yields a URL that fails until they add a record.
    const stage = deriveStageDomain(candidates, parsePlatformSuffixes(process.env.JONGO_PLATFORM_DOMAIN_SUFFIXES));
    if (stage.host) {
      return toHttpsUrl(stage.host);
    }

    for (const candidate of candidates) {
      const productionSlug = extractProductionDomainSlug(candidate);
      if (!productionSlug) {
        continue;
      }

      const deterministicFromProduction = deriveStagingDomainFromTemplate({
        appUuid,
        siteSlug: productionSlug,
        siteName: options?.siteName,
        domainSuffix: options?.domainSuffix
      });
      if (deterministicFromProduction) {
        return deterministicFromProduction;
      }
    }

    for (const candidate of candidates) {
      const derived = buildStagingDomainFromProductionUrl(candidate);
      if (derived) {
        return derived;
      }
    }

    // Nothing usable came back from Coolify — a resource with no domain set at
    // all, or an API that would not answer. The slug template is worse than a
    // production-derived name but better than provisioning with no domain,
    // which skips the deploy entirely.
    return templateFallback;
  } catch {
    return undefined;
  }
}

export type WordPressProvisionResult = {
  ok: boolean;
  /** Coolify uuid of the created service, when it worked. */
  uuid?: string;
  message: string;
  reason?: string;
  /** The domain requested for the new site, if any. */
  domain?: string;
  /** Whether Coolify accepted that domain. False means it is on a generated host. */
  domainApplied?: boolean;
  /**
   * Whether the post-domain restart was accepted. Coolify only regenerates
   * Traefik labels and SERVICE_FQDN_* env on deploy, so without this the app runs
   * on the host it was deployed with and needs a manual restart to work.
   */
  restarted?: boolean;
  /** Coolify reports the requested domain as authoritative after the restart. */
  domainConverged?: boolean;
};

/**
 * Create a WordPress site in Coolify.
 *
 * The counterpart to Jongo only ever writing a database row: adding an app used
 * to leave Coolify untouched, so the site existed in the UI and nowhere else.
 *
 * Placement is resolved rather than guessed. The project comes from the
 * client's Coolify project link, and the server from the same resolver staging
 * uses — which falls back to "the only server" when there is exactly one, and
 * REFUSES when there are several and no signal. Creating a customer's site on
 * an arbitrary server is worse than not creating it, and the caller surfaces
 * the reason instead of failing mute.
 */
export async function provisionCoolifyWordPressService(
  input: Omit<WordPressProvisionInput, "serverUuid"> & { serverUuid?: string | null; domain?: string | null }
): Promise<WordPressProvisionResult> {
  const baseUrl = process.env.COOLIFY_API_BASE_URL;
  const token = process.env.COOLIFY_API_TOKEN;
  if (!baseUrl || !token) {
    return { ok: false, message: "Hosting credentials are missing, so the app cannot be created.", reason: "credentials_missing" };
  }

  let serverUuid = (input.serverUuid ?? "").trim();
  if (!serverUuid) {
    try {
      const servers = await coolifyFetch("/api/v1/servers");
      // No source service exists yet — this is a brand new app — so resolution
      // rests entirely on the only-server case, which is the honest answer for
      // a single-server install and a refusal otherwise.
      const resolution = resolveStagingServerUuid({
        service: null,
        servers: Array.isArray(servers) ? (servers as Array<Record<string, unknown>>) : []
      });
      serverUuid = resolution.uuid;
      if (!serverUuid) {
        return {
          ok: false,
          reason: "server_unresolved",
          message: resolution.reason ?? "Could not determine which server to create the app on."
        };
      }
    } catch (error) {
      // "Could not reach Coolify" is wrong — and expensively so — when Coolify
      // answered and refused us. A 401/403 here is almost always the API token
      // or, more often, Coolify's own API IP allowlist (Settings -> API ->
      // Allowed IPs) not containing the address Jongo calls from. Reporting that
      // as unreachable sends whoever is debugging to look at networking.
      const status = error instanceof CoolifyHttpError ? error.status : undefined;
      if (status === 401 || status === 403) {
        return {
          ok: false,
          reason: "coolify_api_forbidden",
          message: `The hosting server refused the request (HTTP ${status}). A platform admin needs to check Jongo's hosting connection.`
        };
      }
      if (isRateLimitError(error)) {
        return { ok: false, reason: "rate_limited", message: "The hosting server is busy. Try again shortly." };
      }
      // Distinguish "Coolify answered with an error" from "we could not reach
      // Coolify". A 500 here was reported as unreachable, which sent debugging at
      // networking when the real cause was Coolify failing to decrypt a stored
      // value ("The MAC is invalid") after being migrated without its APP_KEY.
      if (typeof status === "number") {
        return {
          ok: false,
          reason: "coolify_server_list_failed",
          message: `The hosting server returned HTTP ${status} when listing servers, so the target server could not be chosen. Try again shortly.`
        };
      }
      return { ok: false, reason: "server_unresolved", message: "Could not reach the hosting server to choose where to create the app." };
    }
  }

  const request = buildWordPressServiceRequest({ ...input, serverUuid });
  if (!request.ok) {
    return { ok: false, reason: request.reason, message: request.message };
  }

  const response = await coolifyMutateWithResponse("/api/v1/services", "POST", request.body);
  if (!response.ok) {
    return {
      ok: false,
      reason: "create_failed",
      message: `The hosting server refused to create the app (HTTP ${response.status ?? "unknown"}).`
    };
  }

  const payload = (response.body ?? {}) as Record<string, unknown>;
  const uuid = stringValue(payload, ["uuid", "id"], "");
  if (!uuid) {
    // Created but unidentifiable. Say so plainly: the resource exists in
    // Coolify and the caller must not silently record a site pointing nowhere.
    return {
      ok: false,
      reason: "created_without_uuid",
      message: "The app was created but its id was not returned. It appears here within the hour; don't retry, or a duplicate will be made."
    };
  }

  const domain = (input.domain ?? "").trim();
  if (!domain) {
    return { ok: true, uuid, message: "App created." };
  }

  // Applied AFTER creation, not as part of it: Coolify needs the compose file
  // parsed before it knows the service key that urls[].name must reference, and
  // that does not happen synchronously. Retried a few times for the same
  // reason — a brand new service is the case most likely to be unparsed.
  //
  // Bounded by a wall-clock DEADLINE, not just an attempt count. Each attempt
  // makes several Coolify calls at up to 8s each, so four attempts plus backoff
  // could exceed 60s — and this runs inside the HTTP request that created the
  // site. Cloudflare cuts the connection at ~100s and returns 502 while the
  // origin is still working, so the caller sees a failure for a site that was
  // in fact created.
  const domainDeadline = Date.now() + 35_000;
  let domainApplied = false;
  let domainMessage = "";
  for (let attempt = 0; attempt < 3 && !domainApplied; attempt += 1) {
    if (Date.now() > domainDeadline) {
      domainMessage = "timed out waiting for Coolify to accept the domain";
      break;
    }
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1500));
    const applied = await applyCoolifyServiceDomains(uuid, domain);
    domainApplied = applied.ok;
    domainMessage = applied.message;
    // A domain another resource already claims will never succeed on retry.
    if (!applied.ok && applied.reason === "conflict") break;
  }

  // The PATCH above only stores the domain. Coolify regenerates Traefik labels
  // and the container's SERVICE_FQDN_* environment from the stored fqdn at DEPLOY
  // time, so until the service restarts the new app is still running on whatever
  // host it was deployed with. That is why a freshly created app needed a manual
  // restart before it worked: everything was configured correctly and nothing had
  // re-read it. The staging flow has always done this; creation never did.
  let restarted = false;
  let domainConverged = false;

  if (domainApplied) {
    const restartResponse = await restartCoolifyService(uuid);
    restarted = restartResponse.ok;

    // Coolify queues the restart, so this confirms only that Coolify now treats
    // the domain as authoritative — not that Traefik is already serving it.
    const converged = await readCoolifyServiceDomains(uuid);
    const wanted = normalizeProvisionHost(domain);
    domainConverged = converged.some((value) => normalizeProvisionHost(value) === wanted);
  }

  const restartNote = !domainApplied
    ? ""
    : restarted
      ? " Restarted so the domain takes effect."
      : " The address was saved but the restart did not go through, so the site may need a restart before it answers there.";

  return {
    ok: true,
    uuid,
    domain,
    domainApplied,
    restarted,
    domainConverged,
    // The site exists either way, so this is not a failed creation — but saying
    // "created" while it sits on a generated host is the kind of half-truth
    // that has someone hunting for a domain that was never set.
    message: domainApplied
      ? `App created at ${domain}.${restartNote}`
      : `App created, but the address ${domain} could not be applied${domainMessage ? ` (${domainMessage})` : ""}. Use Apply address to try again.`
  };
}

/** Host-only comparison, so https://x/ and X match when confirming convergence. */
function normalizeProvisionHost(value: string): string {
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

export async function applyCoolifyApplicationDomains(appUuid: string, input: string | string[]): Promise<boolean> {
  const normalizedDomains = normalizeCoolifyDomains(input);
  if (normalizedDomains.length === 0) {
    return false;
  }

  const commaSeparatedDomains = normalizedDomains.join(",");
  const requestBodies: Record<string, unknown>[] = [
    { fqdn: commaSeparatedDomains },
    { domain: commaSeparatedDomains },
    { domains: normalizedDomains },
    { urls: normalizedDomains },
    { domains: commaSeparatedDomains },
    { urls: commaSeparatedDomains }
  ];
  const paths = [
    `/api/v1/applications/${encodeURIComponent(appUuid)}`,
    `/api/v1/applications/${encodeURIComponent(appUuid)}/settings`,
    `/api/v1/applications/${encodeURIComponent(appUuid)}/domains`
  ];

  for (const path of paths) {
    for (const body of requestBodies) {
      const patchOk = await coolifyMutate(path, "PATCH", body);
      if (patchOk) {
        return true;
      }
      const putOk = await coolifyMutate(path, "PUT", body);
      if (putOk) {
        return true;
      }
      const postOk = await coolifyMutate(path, "POST", body);
      if (postOk) {
        return true;
      }
    }
  }

  return false;
}

export async function applyCoolifyApplicationDomain(appUuid: string, fqdn: string): Promise<boolean> {
  return applyCoolifyApplicationDomains(appUuid, fqdn);
}

export async function resolveCoolifyServiceApplicationNames(serviceUuid: string): Promise<string[]> {
  try {
    const payload = await coolifyFetch(`/api/v1/services/${encodeURIComponent(serviceUuid)}`);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return [];
    }

    const service = payload as Record<string, unknown>;
    const applications = ensureArray(service.applications ?? []);
    const names = applications
      .map((application) => stringValue(application, ["name", "service_name", "human_name"], "").trim())
      .filter((value) => value.length > 0);

    return [...new Set(names)];
  } catch (error) {
    // A 404 means this uuid is not a service, which callers read correctly as
    // an empty list. A rate limit means we do not know, and returning [] for
    // that is how a busy moment became "this app has no containers".
    if (isRateLimitError(error)) throw error;
    return [];
  }
}

/**
 * Whether a Coolify resource is a WordPress service — i.e. one that has a
 * `wordpress` application, which is exactly what produces a `wordpress-<uuid>`
 * container and a files volume. This is the reliable eligibility signal for
 * full-site backups; the `siteType` heuristic misclassifies both directions
 * (flags non-WordPress apps as wordpress, and misses real WordPress services).
 *
 * THROWS `CoolifyRateLimitError` when the API limiter is in effect. That is
 * deliberate — returning false for "we could not ask" would classify a
 * WordPress service as something else — but it means a caller rendering a page
 * MUST handle it. An unguarded `await` on this in a Server Component took the
 * backups page down with a 500 whenever the limiter tripped.
 */
export async function isCoolifyWordPressService(serviceUuid: string): Promise<boolean> {
  if (!serviceUuid?.trim()) {
    return false;
  }
  const names = await resolveCoolifyServiceApplicationNames(serviceUuid);
  return names.some((name) => name.toLowerCase() === "wordpress");
}

/**
 * Whether a resource has persistent state worth a full-site backup — covers all
 * three Coolify resource kinds:
 *   - a service (has application containers, hence volumes),
 *   - a standalone database, or
 *   - an application that has persistent storage (data volumes).
 * A stateless application (no persistent storage) returns false. The backup
 * script is still the final arbiter and reports "nothing to back up" if a
 * resource turns out empty at runtime.
 */
/**
 * Why a resource can or cannot be backed up.
 *
 * "Cannot" is not one thing, and collapsing it to a boolean produced the worst
 * message on the backups page: an app whose data lives in hosted Supabase was
 * told "no files or database to back up", which reads as "you have nothing to
 * lose". It has plenty to lose — just nowhere we can reach. A genuinely
 * stateless app and an app with an external database need different words.
 */
export type BackupCapability = {
  backupable: boolean;
  reason:
    | "service_containers"
    | "standalone_database"
    | "persistent_volumes"
    | "linked_database"
    | "external_database"
    | "stateless"
    // Could not be determined — Coolify was unreachable or rate limiting.
    // MUST NOT be treated as "no data": that hides backups from apps that have
    // a database, which is how a 429 turned into "this app has nothing to lose".
    | "unknown";
  /** Hostname only, never the connection string. Set for external_database. */
  externalHost?: string;
};

export async function describeCoolifyBackupCapability(serviceUuid: string): Promise<BackupCapability> {
  if (!serviceUuid?.trim()) {
    return { backupable: false, reason: "unknown" };
  }
  const encoded = encodeURIComponent(serviceUuid);

  // Every lookup below can fail for reasons that say nothing about the app —
  // Coolify rate limits (429) under the load of a platform-wide sweep. A failed
  // probe must end as "unknown", never as "this app has no data".
  let anyProbeFailed = false;

  // Service with application containers?
  try {
    const names = await resolveCoolifyServiceApplicationNames(serviceUuid);
    if (names.length > 0) {
      return { backupable: true, reason: "service_containers" };
    }
  } catch (error) {
    // A 404 means "not a service", which is an answer, not a failure.
    if (!isNotFoundError(error)) anyProbeFailed = true;
  }

  // Standalone database resource?
  try {
    const payload = await coolifyFetch(`/api/v1/databases/${encoded}`);
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      return { backupable: true, reason: "standalone_database" };
    }
  } catch (error) {
    if (!isNotFoundError(error)) anyProbeFailed = true;
  }

  // Application with persistent storage (data volumes)?
  try {
    const storages = await coolifyFetch(`/api/v1/applications/${encoded}/storages`);
    const persistent = (storages as { persistent_storages?: unknown } | null)?.persistent_storages;
    if (Array.isArray(persistent) && persistent.length > 0) {
      return { backupable: true, reason: "persistent_volumes" };
    }
  } catch (error) {
    // 404 = not an application with storages, which is an answer.
    if (!isNotFoundError(error)) anyProbeFailed = true;
  }

  // Application whose data lives in a database ON THIS PLATFORM. Apps reach
  // their database on a Coolify internal hostname that IS the database resource
  // uuid, so a connection string pointing at a known resource means there is
  // something we can back up. A dotted host is an external provider (Supabase,
  // Neon, ...) — not ours to capture, but very much not "nothing".
  try {
    const envs = await coolifyFetch(`/api/v1/applications/${encoded}/envs`);
    if (!Array.isArray(envs)) {
      return { backupable: false, reason: "unknown" };
    }
    // See lib/database-env-detect.ts: matching only five exact URL names missed
    // host-style config and provider-marker-only apps, which showed as "no data
    // to back up" for apps that very much had data.
    const detected = detectDatabaseEnv(envs as Array<Record<string, unknown>>);
    if (detected.kind === "internal") {
      return { backupable: true, reason: "linked_database" };
    }
    if (detected.kind === "external") {
      return { backupable: false, reason: "external_database", externalHost: detected.externalHost };
    }
    // Only now, having actually read the environment, can "no data" be claimed —
    // and only if nothing earlier failed.
    return { backupable: false, reason: anyProbeFailed ? "unknown" : "stateless" };
  } catch {
    return { backupable: false, reason: "unknown" };
  }
}

/**
 * The database resource uuids this app would write to on restore.
 *
 * Used by the shared-database guard: an app that points at a standalone Coolify
 * database does not own that database, and restoring the app overwrites it for
 * everyone else pointing at it too.
 */
export async function resolveCoolifyDatabaseUuids(serviceUuid: string): Promise<string[]> {
  const trimmed = serviceUuid?.trim();
  if (!trimmed) return [];
  const encoded = encodeURIComponent(trimmed);
  const found = new Set<string>();

  // A standalone database resource writes to itself.
  try {
    const payload = await coolifyFetch(`/api/v1/databases/${encoded}`);
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      found.add(trimmed);
    }
  } catch {
    // Not a database.
  }

  // An application writes to whatever internal database its env points at.
  try {
    const envs = await coolifyFetch(`/api/v1/applications/${encoded}/envs`);
    if (Array.isArray(envs)) {
      // Same detector as the capability check: the restore guard must see every
      // database the backup would write to, or it would under-report the blast
      // radius for an app wired up host-style.
      for (const host of detectDatabaseEnv(envs as Array<Record<string, unknown>>).internalHosts) {
        found.add(host);
      }
    }
  } catch {
    // Not an application, or envs unavailable.
  }

  return Array.from(found);
}

export type CoolifyServiceDomainResult = {
  ok: boolean;
  status?: number;
  message: string;
  /** Populated on 409 – Coolify reports which resource already claims the domain. */
  conflicts?: unknown;
  reason?: "credentials_missing" | "no_domains" | "no_application" | "conflict" | "rejected" | "transport";
};

/**
 * Set a single preferred domain on a service's container.
 *
 * `urls[].name` must be the compose service key (e.g. `wordpress`), not the
 * domain and not the Coolify service name; `url` must carry an http/https
 * scheme or Coolify's FILTER_VALIDATE_URL check rejects it. Any key outside
 * Coolify's allowlist fails the whole request with 422, so this sends exactly
 * the supported shape rather than probing variants.
 */
export async function applyCoolifyServiceDomains(
  serviceUuid: string,
  input: string | string[]
): Promise<CoolifyServiceDomainResult> {
  const normalizedDomains = normalizeCoolifyDomains(input);
  if (normalizedDomains.length === 0) {
    return { ok: false, message: "No valid domains provided.", reason: "no_domains" };
  }

  const serviceApplicationNames = await resolveCoolifyServiceApplicationNames(serviceUuid);
  const applicationName = serviceApplicationNames[0];
  if (!applicationName) {
    return {
      ok: false,
      message: "Could not find the service container yet. The service may still be starting.",
      reason: "no_application"
    };
  }

  const response = await coolifyMutateWithResponse(
    `/api/v1/services/${encodeURIComponent(serviceUuid)}`,
    "PATCH",
    {
      urls: [{ name: applicationName, url: normalizedDomains.join(",") }],
      force_domain_override: true
    }
  );

  if (response.ok) {
    return { ok: true, status: response.status, message: "Staging domains updated." };
  }

  if (response.error === "credentials_missing") {
    return { ok: false, message: "Hosting credentials missing.", reason: "credentials_missing" };
  }

  if (response.status === 409) {
    const conflicts = (response.body as Record<string, unknown> | undefined)?.conflicts;
    return {
      ok: false,
      status: 409,
      message: "This address is already used by another site.",
      conflicts,
      reason: "conflict"
    };
  }

  const detail = (() => {
    const body = response.body as Record<string, unknown> | undefined;
    const errors = body?.errors;
    if (errors && typeof errors === "object") {
      return JSON.stringify(errors);
    }
    return typeof body?.message === "string" ? body.message : response.error;
  })();

  return {
    ok: false,
    status: response.status,
    message: `The address update was rejected${detail ? `: ${detail}` : "."}`,
    reason: response.status ? "rejected" : "transport"
  };
}

/**
 * Traefik labels are regenerated by Coolify from `application.fqdn` at deploy
 * time, so a domain change is inert at the edge until the service restarts.
 * Restarting the WordPress container directly does not do this.
 */
export async function restartCoolifyService(serviceUuid: string): Promise<CoolifyMutateResponse> {
  return coolifyMutateWithResponse(
    `/api/v1/services/${encodeURIComponent(serviceUuid)}/restart`,
    "POST"
  );
}

/**
 * Re-read the service and report the domains Coolify considers authoritative.
 * Callers should confirm convergence here rather than assuming the PATCH took.
 */
export async function readCoolifyServiceDomains(serviceUuid: string): Promise<string[]> {
  try {
    const payload = await coolifyFetch(`/api/v1/services/${encodeURIComponent(serviceUuid)}`);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return [];
    }
    return extractStagingDomainList(payload as Record<string, unknown>);
  } catch {
    return [];
  }
}

export async function triggerCoolifyDeploy(
  serviceUuid: string,
  environment: "production" | "staging" = "production"
): Promise<DeployTriggerResult> {
  const baseUrl = process.env.COOLIFY_API_BASE_URL;
  const token = process.env.COOLIFY_API_TOKEN;

  if (!baseUrl || !token) {
    // Never report a deploy that did not happen. This used to return a made-up
    // deployment id, which callers recorded and showed as a real deploy.
    throw new Error("Hosting is not configured (COOLIFY_API_BASE_URL / COOLIFY_API_TOKEN), so nothing was deployed.");
  }

  const timeoutMs = Number(process.env.COOLIFY_TIMEOUT_MS ?? 8000);

  // See lib/coolify-deploy-plan.ts: POST first (Coolify 4.3 answers GET with
  // 405), restart for services, deploy for applications.
  let failure: { status: number; detail: string } | null = null;
  let timedOut = false;
  const noteFailure = (status: number, detail: string) => {
    // "Not found" is the expected answer from the endpoint for the other kind of
    // resource. Report the most informative refusal instead.
    if (!failure || (failure.status === 404 && status !== 404)) failure = { status, detail };
  };

  for (const request of deployRequestPlan(serviceUuid)) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const startedAt = Date.now();
      // Per request, not per loop: a rate-limit wait must not eat the budget.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetch(`${baseUrl}${request.path}`, {
          method: request.method,
          cache: "no-store",
          headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
          signal: controller.signal
        });
      } catch (error) {
        // No answer: Coolify may have accepted the deploy before the timeout.
        if (error instanceof Error && error.name === "AbortError") timedOut = true;
        noteFailure(0, error instanceof Error ? error.message : "request failed");
        break;
      } finally {
        clearTimeout(timer);
      }

      if (response.ok) {
        const payload = ((await response.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
        recordCoolifyEndpointCall({
          path: request.path,
          method: request.method,
          statusCode: response.status,
          success: true,
          responseCount: estimateResponseCount(payload),
          durationMs: Date.now() - startedAt
        });
        const deployments = Array.isArray(payload.deployments) ? (payload.deployments as Record<string, unknown>[]) : [];
        const first = deployments[0] ?? {};
        const realId =
          typeof first.deployment_uuid === "string" && first.deployment_uuid
            ? first.deployment_uuid
            : typeof payload.deployment_uuid === "string" && payload.deployment_uuid
              ? payload.deployment_uuid
              : null;
        const deploymentId = realId ?? `dep-${Date.now()}`;
        return {
          mode: "live",
          deploymentId,
          trackableDeploymentId: request.path.endsWith("/restart") ? null : realId,
          action: request.path.endsWith("/restart") ? "restart" : "deploy",
          message: request.path.endsWith("/restart")
            ? `Restart triggered on ${environment}.`
            : `Deploy triggered on ${environment}.`
        };
      }

      const body = (await response.text().catch(() => "")).slice(0, 300);
      let detail = body;
      try {
        const parsed = JSON.parse(body) as { message?: unknown };
        if (typeof parsed.message === "string") detail = parsed.message;
      } catch {
        // Not JSON; keep the raw text.
      }
      recordCoolifyEndpointCall({
        path: request.path,
        method: request.method,
        statusCode: response.status,
        success: false,
        durationMs: Date.now() - startedAt,
        error: `Deploy request failed (${response.status})`
      });

      if (isRetryableDeployStatus(response.status) && attempt === 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, deployRetryDelaySeconds(response.headers.get("retry-after")) * 1000)
        );
        continue;
      }
      noteFailure(response.status, detail);
      break;
    }
  }

  const reported = failure as { status: number; detail: string } | null;
  throw new CoolifyDeployError(
    `Coolify deploy failed (${reported?.status || 500})${reported?.detail ? `: ${reported.detail}` : ""}`,
    reported?.status ?? 0,
    timedOut
  );
}

/**
 * A deploy request that did not start a deploy. `status` is Coolify's HTTP
 * status (0 when there was no answer). `mayHaveStarted` is true when a request
 * timed out: Coolify may have accepted it, so retrying could deploy twice.
 */
export class CoolifyDeployError extends Error {
  constructor(message: string, readonly status: number, readonly mayHaveStarted: boolean) {
    super(message);
    this.name = "CoolifyDeployError";
  }
}

export type CoolifyDeploymentState = "queued" | "in_progress" | "finished" | "failed" | "cancelled" | "unknown";

/**
 * Current state of one Coolify deployment (GET /api/v1/deployments/{uuid},
 * documented in Coolify's OpenAPI). Only the status is read; the payload also
 * carries full build logs, which are not needed here.
 */
export async function getCoolifyDeploymentState(deploymentUuid: string): Promise<CoolifyDeploymentState> {
  const payload = (await coolifyFetch(`/api/v1/deployments/${encodeURIComponent(deploymentUuid)}`)) as
    | Record<string, unknown>
    | null;
  const status = typeof payload?.status === "string" ? payload.status : "";
  switch (status) {
    case "queued":
    case "in_progress":
    case "finished":
    case "failed":
      return status;
    case "cancelled-by-user":
      return "cancelled";
    default:
      return "unknown";
  }
}

// ─── Backup Inventory Types ───────────────────────────────────────────────────

