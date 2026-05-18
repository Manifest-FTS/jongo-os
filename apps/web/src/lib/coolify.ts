import { recordCoolifyEndpointCall, recordCoolifyInventoryResult } from "@/lib/diagnostics";
import { detectResourceType } from "./resource-types";

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

export type SiteType = "wordpress" | "generic";

export type SiteOverview = {
  id: string;
  name: string;
  deployTargetId: string;
  status: "healthy" | "degraded" | "error" | "unknown";
  productionStatus: "healthy" | "degraded" | "error" | "unknown";
  stagingStatus: "healthy" | "degraded" | "error" | "unknown";
  siteType: SiteType;
  coolifyProjectId?: string;
  coolifyProjectName?: string;
  coolifyEnvironmentId?: string;
  coolifyEnvironmentName?: string;
  resourceType?: string;
};

export type CoolifyProjectRecord = {
  id: string;
  name: string;
  numericId?: string;
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
 * Detect site type from Coolify resource metadata.
 * Priority order (highest confidence first):
 *   1. docker_registry_image_name — image for Docker Image deployments (e.g. "wordpress", "bitnami/wordpress")
 *   2. static_image              — static/pre-built image field
 *   3. git_repository            — repository URL may contain "wordpress"
 *   4. description               — free-text description field
 *   5. name                      — resource name: last resort, most fragile
 *
 * Returns "wordpress" only if one of the above clearly indicates WordPress.
 * Falls back to "generic" when metadata is absent or inconclusive.
 */
export function detectSiteType(resource: Record<string, unknown>): SiteType {
  const wp = /wordpress|bitnami\/wordpress/i;

  // 1 & 2: image fields — highest signal
  for (const field of ["docker_registry_image_name", "static_image"]) {
    const val = resource[field];
    if (typeof val === "string" && wp.test(val)) return "wordpress";
  }

  // 3: git repository URL
  const gitRepo = resource.git_repository;
  if (typeof gitRepo === "string" && /wordpress/i.test(gitRepo)) return "wordpress";

  // 4: description free text
  const description = resource.description;
  if (typeof description === "string" && /wordpress/i.test(description)) return "wordpress";

  // 5: name — last fallback
  const name = resource.name;
  if (typeof name === "string" && (/wordpress/i.test(name) || /\bwp[-_ ]/i.test(name) || /[-_ ]wp\b/i.test(name))) {
    return "wordpress";
  }

  return "generic";
}

function statusFromRaw(value: unknown): SiteOverview["status"] {
  if (typeof value !== "string") return "unknown";
  const normalized = value.toLowerCase();

  if (normalized.includes("running") || normalized.includes("success") || normalized.includes("healthy")) {
    return "healthy";
  }

  if (normalized.includes("building") || normalized.includes("pending") || normalized.includes("warning")) {
    return "degraded";
  }

  if (normalized.includes("failed") || normalized.includes("error") || normalized.includes("crash")) {
    return "error";
  }

  // restarting / exited / stopped / unknown / empty raw status → unknown
  return "unknown";
}

function ensureArray(input: unknown): Record<string, unknown>[] {
  if (!Array.isArray(input)) return [];
  return input.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
}

function normalizeArrayPayload(input: unknown): Record<string, unknown>[] {
  const arrayPayload = ensureArray(input);

  if (arrayPayload.length > 0) {
    return arrayPayload;
  }

  if (typeof input !== "object" || input === null) {
    return [];
  }

  const candidateObject = input as Record<string, unknown>;
  const arrayKeys = ["data", "items", "results", "applications", "services", "deployments"];

  for (const key of arrayKeys) {
    const value = candidateObject[key];
    if (Array.isArray(value)) {
      return ensureArray(value);
    }
  }

  return [];
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
    const type = stringValue(resource, ["resource_type", "type", "kind", "service_type"]).toLowerCase();
    const engine = stringValue(resource, ["database_type", "engine", "db_type"]).toLowerCase();
    const hasCompose = typeof resource.docker_compose === "string" || typeof resource.docker_compose_raw === "string";
    const hasGitRepo = typeof resource.git_repository === "string";

    if (
      type.includes("database") ||
      type.includes("postgres") ||
      type.includes("mysql") ||
      type.includes("mariadb") ||
      type.includes("redis") ||
      engine.length > 0
    ) {
      databases.push(resource);
      continue;
    }

    if (type.includes("service") || hasCompose) {
      services.push(resource);
      continue;
    }

    if (type.includes("application") || hasGitRepo) {
      applications.push(resource);
      continue;
    }

    // Keep unknown resource types visible in inventory by classifying them as generic services.
    services.push(resource);
  }

  return { applications, services, databases };
}

function estimateResponseCount(input: unknown): number | undefined {
  if (Array.isArray(input)) {
    return input.length;
  }

  if (typeof input !== "object" || input === null) {
    return undefined;
  }

  const candidate = input as Record<string, unknown>;
  for (const key of [
    "data",
    "items",
    "results",
    "applications",
    "services",
    "deployments",
    "databases",
    "projects",
    "environments",
    "resources"
  ]) {
    const value = candidate[key];
    if (Array.isArray(value)) {
      return value.length;
    }
  }

  return undefined;
}

function stringValue(obj: Record<string, unknown>, keys: string[], fallback = ""): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
    if (typeof value === "number") {
      return String(value);
    }
  }
  return fallback;
}

function normalizeProjectRecords(input: unknown): CoolifyProjectRecord[] {
  const seen = new Set<string>();

  return normalizeArrayPayload(input)
    .map((project, index): CoolifyProjectRecord | null => {
      const id = stringValue(project, ["uuid", "id", "project_uuid", "project_id"], `project-${index + 1}`);
      const name = stringValue(project, ["name", "project_name", "display_name"], id);
      const numericId = stringValue(project, ["id"], "") || undefined;

      if (!id || seen.has(id)) {
        return null;
      }

      seen.add(id);
      return { id, name, numericId };
    })
    .filter((project): project is CoolifyProjectRecord => Boolean(project));
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

async function coolifyFetch(path: string): Promise<unknown> {
  const baseUrl = process.env.COOLIFY_API_BASE_URL;
  const token = process.env.COOLIFY_API_TOKEN;
  const timeoutMs = Number(process.env.COOLIFY_TIMEOUT_MS ?? 8000);

  if (!baseUrl || !token) {
    throw new Error("Missing Coolify API environment variables.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let statusCode: number | undefined;
  let callLogged = false;

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "GET",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`
      },
      signal: controller.signal
    });

    statusCode = response.status;

    if (!response.ok) {
      recordCoolifyEndpointCall({
        path,
        statusCode,
        success: false,
        durationMs: Date.now() - startedAt,
        error: `Coolify request failed (${response.status})`
      });
      callLogged = true;
      throw new Error(`Coolify request failed (${response.status}) for ${path}`);
    }

    const payload = await response.json();
    recordCoolifyEndpointCall({
      path,
      statusCode,
      success: true,
      responseCount: estimateResponseCount(payload),
      durationMs: Date.now() - startedAt
    });
    callLogged = true;

    return payload;
  } catch (error) {
    if (!callLogged) {
      recordCoolifyEndpointCall({
        path,
        statusCode,
        success: false,
        durationMs: Date.now() - startedAt,
        error
      });
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function mockOverview(): CoolifyOverview {
  return {
    mode: "mock",
    generatedAt: new Date().toISOString(),
    projects: [
      { id: "project-main", name: "Main Client" },
      { id: "project-portal", name: "Portal Client" }
    ],
    environments: [
      { id: "env-main", name: "production", projectId: "project-main", projectName: "Main Client" },
      { id: "env-portal", name: "production", projectId: "project-portal", projectName: "Portal Client" }
    ],
    sites: [
      {
        id: "site-main",
        deployTargetId: "site-main",
        name: "Main Marketing Site",
        status: "healthy",
        productionStatus: "healthy",
        stagingStatus: "degraded",
        siteType: "generic",
        coolifyProjectId: "project-main",
        coolifyProjectName: "Main Client"
      },
      {
        id: "site-client-portal",
        deployTargetId: "site-client-portal",
        name: "Client Portal",
        status: "degraded",
        productionStatus: "healthy",
        stagingStatus: "degraded",
        siteType: "generic",
        coolifyProjectId: "project-portal",
        coolifyProjectName: "Portal Client"
      }
    ],
    deployments: [
      {
        id: "dep-001",
        siteName: "Main Marketing Site",
        environment: "production",
        status: "healthy",
        finishedAt: new Date(Date.now() - 1000 * 60 * 50).toISOString()
      },
      {
        id: "dep-002",
        siteName: "Client Portal",
        environment: "staging",
        status: "degraded",
        finishedAt: new Date(Date.now() - 1000 * 60 * 140).toISOString()
      }
    ],
    stats: {
      healthySites: 1,
      degradedSites: 1,
      errorSites: 0,
      unknownSites: 0
    }
  };
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
    resourceType: resourceTypeMetadata.type
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
    const overview = mockOverview();
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
  mode: "live" | "mock";
  deploymentId: string;
  message: string;
};

export async function triggerCoolifyDeploy(
  serviceUuid: string,
  environment: "production" | "staging" = "production"
): Promise<DeployTriggerResult> {
  const baseUrl = process.env.COOLIFY_API_BASE_URL;
  const token = process.env.COOLIFY_API_TOKEN;

  if (!baseUrl || !token) {
    // Mock mode: return a synthetic deployment ID
    return {
      mode: "mock",
      deploymentId: `mock-dep-${Date.now()}`,
      message: `Mock deploy triggered for ${serviceUuid} (${environment}). Set COOLIFY_API_BASE_URL and COOLIFY_API_TOKEN to trigger real deploys.`
    };
  }

  const timeoutMs = Number(process.env.COOLIFY_TIMEOUT_MS ?? 8000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const path = `/api/v1/deploy?uuid=${encodeURIComponent(serviceUuid)}`;

    const response = await fetch(`${baseUrl}${path}`, {
      method: "GET",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Coolify deploy failed (${response.status})`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const deployments = Array.isArray(payload.deployments) ? payload.deployments as Record<string, unknown>[] : [];
    const first = deployments[0] ?? {};
    const deploymentId =
      typeof first.deployment_uuid === "string"
        ? first.deployment_uuid
        : typeof payload.deployment_uuid === "string"
          ? payload.deployment_uuid
          : `dep-${Date.now()}`;

    return {
      mode: "live",
      deploymentId,
      message: `Deploy triggered on ${environment}.`
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Backup Inventory Types ───────────────────────────────────────────────────

export type BackupScheduleRecord = {
  id: string;
  resourceId: string;
  resourceName: string;
  resourceType: "database" | "application";
  enabled: boolean;
  frequency?: string;       // cron e.g. "0 2 * * *"
  retentionAmount?: number;
  retentionDays?: number;
  lastBackupAt?: string;
  lastBackupStatus?: "success" | "failed" | "running" | "unknown";
};

export type BackupExecutionRecord = {
  id: string;
  status: "success" | "failed" | "running" | "unknown";
  startedAt?: string;
  finishedAt?: string;
  sizeBytes?: number;
  filename?: string;
};

export type AppBackupInventory = {
  configured: boolean;
  schedules: BackupScheduleRecord[];
  recentExecutions: BackupExecutionRecord[];
  source: "live" | "unavailable";
  note?: string;
  checkedAt: string;
};

// ─── Staging Capability Types ─────────────────────────────────────────────────

export type StagingCapabilityRecord = {
  detected: boolean;
  environmentId?: string;
  environmentName?: string;
  applicationUuid?: string;
  applicationName?: string;
  fqdn?: string;
  status?: "healthy" | "degraded" | "error" | "unknown";
  note?: string;
  /** ISO timestamp of when this probe ran. */
  checkedAt: string;
};

// ─── Dry-Run Sync Plan Types ──────────────────────────────────────────────────

export type StagingSyncPlan = {
  source: { uuid: string; name: string; environment: string; fqdn?: string };
  target: { uuid: string; name: string; environment: string; fqdn?: string } | null;
  databaseBehavior: "snapshot-then-overwrite" | "skip" | "unknown";
  filesBehavior: "rsync-overwrite" | "skip" | "unknown";
  domainBehavior: "staging-domain-unchanged" | "temporary-domain" | "unknown";
  risks: string[];
  warnings: string[];
  note?: string;
};

// ─── Backup Inventory Fetching ────────────────────────────────────────────────

function normalizeBackupSchedule(raw: Record<string, unknown>, resourceId: string, resourceName: string): BackupScheduleRecord {
  const id = stringValue(raw, ["id", "uuid"], resourceId);
  const enabled = raw.enabled === true || raw.is_enabled === true;
  const frequency = stringValue(raw, ["frequency", "cron", "schedule"], "") || undefined;
  const retentionAmount = typeof raw.database_backup_retention_amount_locally === "number"
    ? raw.database_backup_retention_amount_locally
    : typeof raw.retention_amount === "number" ? raw.retention_amount : undefined;
  const retentionDays = typeof raw.database_backup_retention_days_locally === "number"
    ? raw.database_backup_retention_days_locally
    : typeof raw.retention_days === "number" ? raw.retention_days : undefined;

  return { id, resourceId, resourceName, resourceType: "database", enabled, frequency, retentionAmount, retentionDays };
}

function normalizeBackupExecution(raw: Record<string, unknown>): BackupExecutionRecord {
  const id = stringValue(raw, ["id", "uuid"], `exec-${Date.now()}`);
  const statusRaw = stringValue(raw, ["status", "result", "state"], "").toLowerCase();
  let status: BackupExecutionRecord["status"] = "unknown";
  if (statusRaw.includes("success") || statusRaw.includes("finish") || statusRaw.includes("complet")) {
    status = "success";
  } else if (statusRaw.includes("fail") || statusRaw.includes("error")) {
    status = "failed";
  } else if (statusRaw.includes("run") || statusRaw.includes("pending") || statusRaw.includes("in_progress")) {
    status = "running";
  }
  const startedAt = stringValue(raw, ["started_at", "created_at"], "") || undefined;
  const finishedAt = stringValue(raw, ["finished_at", "updated_at"], "") || undefined;
  const sizeBytes = typeof raw.size === "number" ? raw.size : undefined;
  const filename = stringValue(raw, ["filename", "file_name", "dump_file"], "") || undefined;
  return { id, status, startedAt, finishedAt, sizeBytes, filename };
}

/**
 * Fetch read-only backup inventory for a Coolify application UUID.
 * Tries to resolve the application's project/environment, then finds associated
 * databases and their backup schedules. Never triggers or modifies anything.
 */
export async function getCoolifyAppBackupInventory(appUuid: string): Promise<AppBackupInventory> {
  const baseUrl = process.env.COOLIFY_API_BASE_URL;
  const token = process.env.COOLIFY_API_TOKEN;
  const checkedAt = new Date().toISOString();

  if (!baseUrl || !token) {
    return { configured: false, schedules: [], recentExecutions: [], source: "unavailable", note: "missing_credentials", checkedAt };
  }

  try {
    // Step 1: Fetch the application to find its environment_id
    let appRaw: Record<string, unknown> | null = null;
    try {
      const payload = await coolifyFetch(`/api/v1/applications/${appUuid}`);
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        appRaw = payload as Record<string, unknown>;
      }
    } catch {
      // Application details unavailable – continue to try other paths
    }

    const schedules: BackupScheduleRecord[] = [];
    const recentExecutions: BackupExecutionRecord[] = [];

    // Step 2: Try to get databases in the same project/environment
    const projectId = appRaw
      ? stringValue(appRaw, ["project_uuid", "project_id", "project"], "")
      : "";
    const environmentId = appRaw
      ? stringValue(appRaw, ["environment_id", "environment_uuid"], "")
      : "";

    let databases: Record<string, unknown>[] = [];

    if (projectId && environmentId) {
      try {
        const envPayload = await coolifyFetch(`/api/v1/projects/${projectId}/environments/${environmentId}`);
        const envObj = envPayload && typeof envPayload === "object" && !Array.isArray(envPayload)
          ? (envPayload as Record<string, unknown>)
          : {};
        databases = ensureArray(envObj.databases ?? envObj.standalone_postgresqls ?? []);
      } catch {
        // Best effort
      }
    }

    // Step 3: For each database, attempt to read its backup config
    for (const db of databases.slice(0, 5)) {
      const dbId = stringValue(db, ["uuid", "id"], "");
      const dbName = stringValue(db, ["name", "database_name"], dbId);
      if (!dbId) continue;

      try {
        const backupPayload = await coolifyFetch(`/api/v1/databases/${dbId}/backups`);
        const backupRaw = Array.isArray(backupPayload) ? backupPayload : [];

        for (const bkp of backupRaw) {
          if (typeof bkp !== "object" || !bkp) continue;
          const bkpObj = bkp as Record<string, unknown>;
          schedules.push(normalizeBackupSchedule(bkpObj, dbId, dbName));

          const executions = ensureArray(bkpObj.executions ?? bkpObj.backup_executions ?? []);
          for (const exec of executions.slice(0, 5)) {
            recentExecutions.push(normalizeBackupExecution(exec as Record<string, unknown>));
          }
        }
      } catch {
        // Backup endpoint unavailable for this database
      }
    }

    const configured = schedules.some((s) => s.enabled);
    return {
      configured,
      schedules,
      recentExecutions: recentExecutions.slice(0, 10),
      source: "live",
      note: databases.length === 0 ? "no_databases_in_environment" : undefined,
      checkedAt
    };
  } catch {
    return { configured: false, schedules: [], recentExecutions: [], source: "unavailable", note: "fetch_error", checkedAt };
  }
}

// ─── Staging Capability Detection ────────────────────────────────────────────

/**
 * Detect staging capability for a given Coolify application.
 * Looks for a staging environment in the same project and for a staging application.
 * Read-only – never creates or modifies resources.
 */
export async function getCoolifyAppStagingCapability(appUuid: string, projectId?: string): Promise<StagingCapabilityRecord> {
  const baseUrl = process.env.COOLIFY_API_BASE_URL;
  const token = process.env.COOLIFY_API_TOKEN;
  const checkedAt = new Date().toISOString();

  if (!baseUrl || !token) {
    return { detected: false, note: "missing_credentials", checkedAt };
  }

  try {
    // Resolve project if not supplied
    let resolvedProjectId = projectId;
    if (!resolvedProjectId) {
      try {
        const appPayload = await coolifyFetch(`/api/v1/applications/${appUuid}`);
        if (appPayload && typeof appPayload === "object" && !Array.isArray(appPayload)) {
          resolvedProjectId = stringValue(appPayload as Record<string, unknown>, ["project_uuid", "project_id", "project"], "");
        }
      } catch {
        return { detected: false, note: "application_not_found", checkedAt };
      }
    }

    if (!resolvedProjectId) {
      return { detected: false, note: "no_project_resolved", checkedAt };
    }

    // Get all environments for the project
    const projectPayload = await coolifyFetch(`/api/v1/projects/${resolvedProjectId}`);
    const projectObj = projectPayload && typeof projectPayload === "object" && !Array.isArray(projectPayload)
      ? (projectPayload as Record<string, unknown>)
      : {};
    const environments = ensureArray(projectObj.environments ?? []);

    const stagingEnv = environments.find((env) => {
      const name = stringValue(env as Record<string, unknown>, ["name"], "").toLowerCase();
      return name.includes("stag") || name.includes("preview") || name === "dev";
    });

    if (!stagingEnv) {
      return { detected: false, note: "no_staging_environment_in_project", checkedAt };
    }

    const stagingEnvObj = stagingEnv as Record<string, unknown>;
    const stagingEnvId = stringValue(stagingEnvObj, ["id", "uuid"], "");
    const stagingEnvName = stringValue(stagingEnvObj, ["name"], "staging");

    // Look for an application in the staging environment
    const stagingApplications = ensureArray(stagingEnvObj.applications ?? []);
    const stagingApp = stagingApplications[0] as Record<string, unknown> | undefined;

    if (!stagingApp) {
      return {
        detected: true,
        environmentId: stagingEnvId,
        environmentName: stagingEnvName,
        note: "staging_environment_exists_no_application",
        checkedAt
      };
    }

    const stagingAppUuid = stringValue(stagingApp, ["uuid", "id"], "");
    const stagingAppName = stringValue(stagingApp, ["name"], "staging app");
    const fqdn = stringValue(stagingApp, ["fqdn", "staging_fqdn", "urls"], "") || undefined;
    const status = statusFromRaw(stagingApp.status ?? stagingApp.current_status);

    return {
      detected: true,
      environmentId: stagingEnvId,
      environmentName: stagingEnvName,
      applicationUuid: stagingAppUuid || undefined,
      applicationName: stagingAppName || undefined,
      fqdn,
      status,
      note: "full_staging_detected",
      checkedAt
    };
  } catch {
    return { detected: false, note: "fetch_error", checkedAt };
  }
}

// ─── Staging Sync Dry-Run Plan ────────────────────────────────────────────────

/**
 * Build a read-only dry-run plan for a production→staging sync.
 * This describes what WOULD happen – never executes anything.
 */
export async function buildStagingSyncDryRunPlan(
  productionAppUuid: string,
  productionAppName: string,
  stagingCapability: StagingCapabilityRecord
): Promise<StagingSyncPlan> {
  const source = {
    uuid: productionAppUuid,
    name: productionAppName,
    environment: "production"
  };

  if (!stagingCapability.detected || !stagingCapability.applicationUuid) {
    return {
      source,
      target: null,
      databaseBehavior: "unknown",
      filesBehavior: "unknown",
      domainBehavior: "unknown",
      risks: ["No staging environment detected – cannot plan sync."],
      warnings: ["Enable staging first in Settings."]
    };
  }

  const target = {
    uuid: stagingCapability.applicationUuid,
    name: stagingCapability.applicationName ?? "Staging App",
    environment: stagingCapability.environmentName ?? "staging",
    fqdn: stagingCapability.fqdn
  };

  return {
    source,
    target,
    databaseBehavior: "snapshot-then-overwrite",
    filesBehavior: "rsync-overwrite",
    domainBehavior: "staging-domain-unchanged",
    risks: [
      "Staging database will be overwritten with a snapshot of production data.",
      "Any staging-only content will be lost."
    ],
    warnings: [
      "Review staging domain configuration before executing.",
      "Ensure production is stable before syncing to avoid copying bad state."
    ],
    note: "dry_run_only"
  };
}
