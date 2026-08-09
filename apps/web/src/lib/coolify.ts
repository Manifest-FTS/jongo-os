import { recordCoolifyEndpointCall, recordCoolifyInventoryResult } from "@/lib/diagnostics";
import { deriveStageDomain, parsePlatformSuffixes } from "@/lib/stage-domain";
import { buildWordPressServiceRequest, type WordPressProvisionInput } from "@/lib/wordpress-provision";
import { detectResourceType } from "./resource-types";
import { resolveStagingServerUuid, type ServerResolution } from "./coolify-server-resolve";
import { encodeComposeForCoolify } from "./compose-encoding";
import { detectDatabaseEnv } from "./database-env-detect";
import { CoolifyRateLimitError, CoolifyHttpError, isNotFoundError, isRateLimitError, noteRateLimited, rateLimitCooldownRemaining } from "./coolify-rate-limit";

export { isGeneratedCoolifyHost } from "./coolify-host";

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

export type SiteType = "wordpress" | "database" | "service" | "generic";

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

function statusFromRaw(value: unknown): SiteOverview["status"] {
  if (typeof value !== "string") return "unknown";
  const normalized = value.toLowerCase();

  // Prioritize explicit failure/degraded signals before healthy checks.
  if (
    normalized.includes("failed") ||
    normalized.includes("error") ||
    normalized.includes("crash") ||
    normalized.includes("unhealthy")
  ) {
    return "error";
  }

  if (
    normalized.includes("degraded") ||
    normalized.includes("building") ||
    normalized.includes("pending") ||
    normalized.includes("warning") ||
    normalized.includes("stopped") ||
    normalized.includes("exited") ||
    normalized.includes("sleep")
  ) {
    return "degraded";
  }

  if (normalized.includes("running") || normalized.includes("success") || normalized.includes("healthy")) {
    return "healthy";
  }

  // restarting / unknown / empty raw status → unknown
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

export async function coolifyFetch(path: string): Promise<unknown> {
  const baseUrl = process.env.COOLIFY_API_BASE_URL;
  const token = process.env.COOLIFY_API_TOKEN;
  const timeoutMs = Number(process.env.COOLIFY_TIMEOUT_MS ?? 8000);

  if (!baseUrl || !token) {
    throw new Error("Missing Coolify API environment variables.");
  }

  // Coolify allows 200 requests/minute per token. Once that is hit, every
  // further call is wasted and keeps the limiter pinned, so stop until the
  // window rolls over. Callers get a distinguishable error rather than one they
  // might mistake for "this resource does not exist".
  const cooldown = rateLimitCooldownRemaining();
  if (cooldown > 0) {
    throw new CoolifyRateLimitError(cooldown);
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
      if (response.status === 429) {
        const waited = noteRateLimited(Number(response.headers.get("retry-after")));
        throw new CoolifyRateLimitError(waited);
      }
      throw new CoolifyHttpError(response.status, path);
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

async function resolveCoolifyProjectEndpointId(projectId: string): Promise<string> {
  if (!projectId) {
    return projectId;
  }

  try {
    await coolifyFetch(`/api/v1/projects/${projectId}`);
    return projectId;
  } catch {
    if (/^\d+$/.test(projectId)) {
      return projectId;
    }

    const projectsPayload = await coolifyFetch("/api/v1/projects");
    const projects = normalizeProjectRecords(projectsPayload);
    const normalizedProjectId = projectId.trim().toLowerCase();

    const matchedProject = projects.find((project) => {
      if (project.id.trim().toLowerCase() === normalizedProjectId) {
        return true;
      }

      return Boolean(project.numericId && project.numericId.trim().toLowerCase() === normalizedProjectId);
    });

    return matchedProject?.numericId || matchedProject?.id || projectId;
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

export type CoolifyActionResult = {
  mode: "live" | "mock";
  ok: boolean;
  message: string;
  reason?:
    | "credentials_missing"
    | "auto_provision_unsupported"
    | "request_sent"
    | "environment_ready"
    | "environment_created"
    | "environment_deleted"
    | "service_created"
    | "resource_deleted"
    | "resource_already_absent"
    | "forbidden"
    | "environment_create_failed";
  /** HTTP status from Coolify, when the failure came from a rejected request. */
  status?: number;
  /** Provisioning attempt diagnostics for staged create/delete flows. */
  attempts?: Array<{
    path: string;
    method: "POST" | "PATCH" | "PUT" | "DELETE";
    ok: boolean;
    status?: number;
    error?: string;
  }>;
};

type StagingEnvironmentResolution = {
  projectEndpointId: string;
  stagingEnvironmentId?: string;
  stagingEnvironmentName?: string;
  created: boolean;
};

export async function coolifyMutate(
  path: string,
  method: "POST" | "DELETE" | "PATCH" | "PUT",
  body?: Record<string, unknown>
): Promise<boolean> {
  const baseUrl = process.env.COOLIFY_API_BASE_URL;
  const token = process.env.COOLIFY_API_TOKEN;
  const timeoutMs = Number(process.env.COOLIFY_TIMEOUT_MS ?? 8000);

  if (!baseUrl || !token) {
    return false;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });

    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export type CoolifyMutateResponse = {
  ok: boolean;
  status?: number;
  body?: unknown;
  error?: string;
};

/**
 * Same as coolifyMutate, but preserves status and response body.
 * Coolify answers 422 for a bad payload shape and 409 for a domain conflict;
 * both are indistinguishable from a transport failure through a bare boolean.
 */
export async function coolifyMutateWithResponse(
  path: string,
  method: "POST" | "DELETE" | "PATCH" | "PUT",
  body?: Record<string, unknown>
): Promise<CoolifyMutateResponse> {
  const baseUrl = process.env.COOLIFY_API_BASE_URL;
  const token = process.env.COOLIFY_API_TOKEN;
  const timeoutMs = Number(process.env.COOLIFY_TIMEOUT_MS ?? 8000);

  if (!baseUrl || !token) {
    return { ok: false, error: "credentials_missing" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }

    return { ok: response.ok, status: response.status, body: parsed };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "request_failed" };
  } finally {
    clearTimeout(timer);
  }
}

function extractFirstHostLikeValue(raw: string): string | undefined {
  const tokens = raw
    .split(/[\s,;]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  return tokens[0];
}

function toHttpsUrl(input: string): string | undefined {
  const candidate = input.trim();
  if (!candidate) {
    return undefined;
  }

  try {
    const parsed = new URL(candidate);
    if (!parsed.hostname) {
      return undefined;
    }
    return `https://${parsed.hostname}`;
  } catch {
    try {
      const parsed = new URL(`https://${candidate.replace(/^https?:\/\//i, "")}`);
      if (!parsed.hostname) {
        return undefined;
      }
      return `https://${parsed.hostname}`;
    } catch {
      return undefined;
    }
  }
}

function normalizeCoolifyDomains(input: string | string[]): string[] {
  const rawValues = Array.isArray(input)
    ? input
    : input
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const raw of rawValues) {
    const value = toHttpsUrl(raw);
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }

  return normalized;
}

function extractCoolifyDomainCandidates(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }

  if (Array.isArray(value)) {
    const values: string[] = [];
    for (const entry of value) {
      if (typeof entry === "string") {
        values.push(entry);
        continue;
      }

      if (typeof entry === "object" && entry !== null) {
        const record = entry as Record<string, unknown>;
        const urlCandidate = stringValue(record, ["url", "fqdn", "domain", "name"], "");
        if (urlCandidate) {
          values.push(urlCandidate);
        }
      }
    }
    return values;
  }

  return [];
}

function extractStagingDomainList(target: Record<string, unknown>): string[] {
  const nestedChildren = [
    ...ensureArray(target.applications ?? []),
    ...ensureArray(target.databases ?? []),
    ...ensureArray(target.services ?? [])
  ];

  const nestedCandidates = nestedChildren.flatMap((entry) => {
    const record = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    return [
      ...extractCoolifyDomainCandidates(record.fqdn),
      ...extractCoolifyDomainCandidates(record.staging_fqdn),
      ...extractCoolifyDomainCandidates(record.domain),
      ...extractCoolifyDomainCandidates(record.domains),
      ...extractCoolifyDomainCandidates(record.url),
      ...extractCoolifyDomainCandidates(record.urls)
    ];
  });

  const candidates = [
    ...extractCoolifyDomainCandidates(target.fqdn),
    ...extractCoolifyDomainCandidates(target.staging_fqdn),
    ...extractCoolifyDomainCandidates(target.domain),
    ...extractCoolifyDomainCandidates(target.domains),
    ...extractCoolifyDomainCandidates(target.url),
    ...extractCoolifyDomainCandidates(target.urls),
    ...nestedCandidates
  ];

  return normalizeCoolifyDomains(candidates);
}

function buildStagingResourceName(sourceName: string): string {
  const generatedSlugPattern = /(?:wordpress|mysql|mariadb|service|app)(?:-[a-z0-9]+)*-[a-z0-9]{10,}$/i;
  const trimmed = sourceName.trim();
  if (!trimmed) {
    return "staging-service";
  }

  if (/^staging[-.]/i.test(trimmed)) {
    return trimmed;
  }

  if (generatedSlugPattern.test(trimmed)) {
    return "staging-app";
  }

  return `staging-${trimmed}`;
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
    return { ok: false, message: "Coolify credentials are missing, so the app cannot be created.", reason: "credentials_missing" };
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
          message: resolution.reason ?? "Could not determine which Coolify server to create the app on."
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
          message: `Coolify refused the API request (HTTP ${status}). Check the API token, and that Coolify's API allowed-IPs list includes the address Jongo calls from.`
        };
      }
      if (isRateLimitError(error)) {
        return { ok: false, reason: "rate_limited", message: "Coolify's API rate limit is in effect. Try again shortly." };
      }
      return { ok: false, reason: "server_unresolved", message: "Could not reach Coolify to determine which server to use." };
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
      message: `Coolify refused to create the app (HTTP ${response.status ?? "unknown"}).`
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
      message: "Coolify created the app but did not return its id. Check Coolify before retrying, or a duplicate will be made."
    };
  }

  const domain = (input.domain ?? "").trim();
  if (!domain) {
    return { ok: true, uuid, message: "App created in Coolify." };
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

  return {
    ok: true,
    uuid,
    domain,
    domainApplied,
    // The site exists either way, so this is not a failed creation — but saying
    // "created" while it sits on a generated host is the kind of half-truth
    // that has someone hunting for a domain that was never set.
    message: domainApplied
      ? `App created in Coolify at ${domain}.`
      : `App created in Coolify, but the domain ${domain} could not be applied${domainMessage ? `: ${domainMessage}` : ""}. Set it in Coolify.`
  };
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

/** Boolean form, for callers that only gate on eligibility. */
export async function hasCoolifyBackupableState(serviceUuid: string): Promise<boolean> {
  return (await describeCoolifyBackupCapability(serviceUuid)).backupable;
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
      message: "Could not resolve the service container name from Coolify. The service may not be parsed yet.",
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
    return { ok: false, message: "Coolify credentials missing.", reason: "credentials_missing" };
  }

  if (response.status === 409) {
    const conflicts = (response.body as Record<string, unknown> | undefined)?.conflicts;
    return {
      ok: false,
      status: 409,
      message: "Domain is already claimed by another Coolify resource.",
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
    message: `Coolify rejected the domain update${detail ? `: ${detail}` : "."}`,
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

function isLikelyStagingEnvironmentName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized.includes("stag") || normalized.includes("preview") || normalized === "dev";
}

export async function ensureCoolifyStagingEnvironment(projectId: string): Promise<CoolifyActionResult> {
  const baseUrl = process.env.COOLIFY_API_BASE_URL;
  const token = process.env.COOLIFY_API_TOKEN;

  if (!baseUrl || !token) {
    return {
      mode: "mock",
      ok: false,
      message: "Coolify credentials missing. Staging environment cannot be created from this environment.",
      reason: "credentials_missing"
    };
  }

  try {
    const projectEndpointId = await resolveCoolifyProjectEndpointId(projectId);
    const projectPayload = await coolifyFetch(`/api/v1/projects/${projectEndpointId}`);
    const projectObj = projectPayload && typeof projectPayload === "object" && !Array.isArray(projectPayload)
      ? (projectPayload as Record<string, unknown>)
      : {};
    const environments = ensureArray(projectObj.environments ?? []);

    const existingStagingEnv = environments.find((env) => {
      const name = stringValue(env as Record<string, unknown>, ["name", "environment_name"], "");
      return isLikelyStagingEnvironmentName(name);
    });

    if (existingStagingEnv) {
      return {
        mode: "live",
        ok: true,
        message: "Staging environment already exists in Coolify.",
        reason: "environment_ready"
      };
    }

    const created = await coolifyMutateWithResponse(
      `/api/v1/projects/${encodeURIComponent(projectEndpointId)}/environments`,
      "POST",
      { name: "staging" }
    );

    if (created.ok) {
      return {
        mode: "live",
        ok: true,
        message: "Staging environment created in Coolify.",
        reason: "environment_created"
      };
    }

    // POST /projects/{uuid}/environments exists and requires api.ability:write.
    // Reporting every failure as "unsupported" hides the actual cause (403 for a
    // read-only token, 403 from the instance allowed_ips list, 422 for payload).
    const detail = (() => {
      const body = created.body as Record<string, unknown> | undefined;
      if (body?.errors && typeof body.errors === "object") {
        return JSON.stringify(body.errors);
      }
      return typeof body?.message === "string" ? body.message : created.error;
    })();

    return {
      mode: "live",
      ok: false,
      message: `Coolify rejected staging environment creation (HTTP ${created.status ?? "n/a"})${detail ? `: ${detail}` : "."}`,
      reason: created.status === 403 ? "forbidden" : "environment_create_failed",
      status: created.status
    };
  } catch (error) {
    return {
      mode: "live",
      ok: false,
      message: `Staging environment creation failed: ${error instanceof Error ? error.message : "unknown error"}`,
      reason: "environment_create_failed"
    };
  }
}

export async function deleteCoolifyStagingEnvironment(projectId: string): Promise<CoolifyActionResult> {
  const baseUrl = process.env.COOLIFY_API_BASE_URL;
  const token = process.env.COOLIFY_API_TOKEN;

  if (!baseUrl || !token) {
    return {
      mode: "mock",
      ok: false,
      message: "Coolify credentials missing. Staging environment cannot be deleted from this environment.",
      reason: "credentials_missing"
    };
  }

  try {
    const projectEndpointId = await resolveCoolifyProjectEndpointId(projectId);
    const projectPayload = await coolifyFetch(`/api/v1/projects/${projectEndpointId}`);
    const projectObj = projectPayload && typeof projectPayload === "object" && !Array.isArray(projectPayload)
      ? (projectPayload as Record<string, unknown>)
      : {};
    const environments = ensureArray(projectObj.environments ?? []);

    const stagingEnv = environments.find((env) => {
      const name = stringValue(env as Record<string, unknown>, ["name", "environment_name"], "");
      return isLikelyStagingEnvironmentName(name);
    }) as Record<string, unknown> | undefined;

    if (!stagingEnv) {
      return {
        mode: "live",
        ok: true,
        message: "No staging environment exists in Coolify to delete.",
        reason: "environment_ready"
      };
    }

    const envUuid = stringValue(stagingEnv, ["uuid"], "");
    const envId = stringValue(stagingEnv, ["id"], "");
    if (!envUuid && !envId) {
      return {
        mode: "live",
        ok: false,
        message: "Staging environment identifier was not found; delete must be completed manually.",
        reason: "auto_provision_unsupported"
      };
    }

    const deletePaths: string[] = [];
    if (envUuid) {
      deletePaths.push(`/api/v1/projects/${encodeURIComponent(projectEndpointId)}/environments/${encodeURIComponent(envUuid)}`);
    }
    if (envId) {
      deletePaths.push(`/api/v1/projects/${encodeURIComponent(projectEndpointId)}/environments/${encodeURIComponent(envId)}`);
    }

    let deleted = false;
    for (const path of deletePaths) {
      deleted = await coolifyMutate(path, "DELETE");
      if (deleted) {
        break;
      }
    }

    if (deleted) {
      return {
        mode: "live",
        ok: true,
        message: "Staging environment deleted in Coolify.",
        reason: "environment_deleted"
      };
    }
  } catch {
    // Fall through to unsupported result.
  }

  return {
    mode: "live",
    ok: false,
    message: "Unable to delete staging environment automatically. Remove it manually in Coolify.",
    reason: "auto_provision_unsupported"
  };
}

export async function provisionCoolifyStagingFromProduction(
  appUuid: string,
  preferredStagingDomain?: string,
  projectId?: string
): Promise<CoolifyActionResult> {
  const baseUrl = process.env.COOLIFY_API_BASE_URL;
  const token = process.env.COOLIFY_API_TOKEN;

  if (!baseUrl || !token) {
    return {
      mode: "mock",
      ok: false,
      message: "Coolify credentials missing. Staging cannot be provisioned from this environment.",
      reason: "credentials_missing"
    };
  }

  const normalizedPreferredDomain = preferredStagingDomain ? toHttpsUrl(preferredStagingDomain) : undefined;
  const provisioningAttempts: Array<{
    path: string;
    method: "POST" | "PATCH" | "PUT" | "DELETE";
    ok: boolean;
    status?: number;
    error?: string;
  }> = [];

  const resolveProvisioningResource = async (): Promise<{
    kind: "service" | "application" | "unknown";
    uuid: string;
  }> => {
    try {
      const servicePayload = await coolifyFetch(`/api/v1/services/${encodeURIComponent(appUuid)}`);
      if (servicePayload && typeof servicePayload === "object" && !Array.isArray(servicePayload)) {
        const service = servicePayload as Record<string, unknown>;
        return {
          kind: "service",
          uuid: stringValue(service, ["uuid", "id"], "") || appUuid
        };
      }
    } catch {
      // Continue to application lookup.
    }

    try {
      const applicationPayload = await coolifyFetch(`/api/v1/applications/${encodeURIComponent(appUuid)}`);
      if (applicationPayload && typeof applicationPayload === "object" && !Array.isArray(applicationPayload)) {
        const application = applicationPayload as Record<string, unknown>;
        return {
          kind: "application",
          uuid: stringValue(application, ["uuid", "id"], "") || appUuid
        };
      }
    } catch {
      // Fall through.
    }

    return { kind: "unknown", uuid: appUuid };
  };

  const provisioningResource = await resolveProvisioningResource();

  const existingCapability = await getCoolifyAppStagingCapability(appUuid, projectId, {
    relaxedTargetMatch: true
  });
  if (existingCapability.detected && existingCapability.applicationUuid) {
    return {
      mode: "live",
      ok: true,
      message: "Staging target already exists in Coolify.",
      reason: "environment_ready"
    };
  }

  const verifyStagingTarget = async (): Promise<boolean> => {
    const capability = await getCoolifyAppStagingCapability(appUuid, projectId, {
      relaxedTargetMatch: true
    });
    if (capability.detected && capability.applicationUuid) {
      return true;
    }

    for (const retryDelayMs of [500, 1000, 2000, 4000]) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      const retriedCapability = await getCoolifyAppStagingCapability(appUuid, projectId, {
        relaxedTargetMatch: true
      });
      if (retriedCapability.detected && retriedCapability.applicationUuid) {
        return true;
      }
    }

    return false;
  };

  const resolveStagingEnvironment = async (): Promise<StagingEnvironmentResolution | null> => {
    if (!projectId) {
      return null;
    }

    try {
      const projectEndpointId = await resolveCoolifyProjectEndpointId(projectId);
      const projectPayload = await coolifyFetch(`/api/v1/projects/${projectEndpointId}`);
      const projectObj = projectPayload && typeof projectPayload === "object" && !Array.isArray(projectPayload)
        ? (projectPayload as Record<string, unknown>)
        : {};
      let environments = ensureArray(projectObj.environments ?? []);

      let stagingEnvironment = environments.find((env) => {
        const name = stringValue(env as Record<string, unknown>, ["name", "environment_name"], "");
        return isLikelyStagingEnvironmentName(name);
      }) as Record<string, unknown> | undefined;

      let created = false;
      if (!stagingEnvironment) {
        const createResult = await coolifyMutateWithResponse(
          `/api/v1/projects/${encodeURIComponent(projectEndpointId)}/environments`,
          "POST",
          { name: "staging" }
        );
        provisioningAttempts.push({
          path: `/api/v1/projects/${encodeURIComponent(projectEndpointId)}/environments`,
          method: "POST",
          ok: createResult.ok,
          status: createResult.status,
          error: createResult.error
        });

        if (createResult.ok) {
          created = true;
          const refreshedProjectPayload = await coolifyFetch(`/api/v1/projects/${projectEndpointId}`);
          const refreshedProjectObj = refreshedProjectPayload && typeof refreshedProjectPayload === "object" && !Array.isArray(refreshedProjectPayload)
            ? (refreshedProjectPayload as Record<string, unknown>)
            : {};
          environments = ensureArray(refreshedProjectObj.environments ?? []);
          stagingEnvironment = environments.find((env) => {
            const name = stringValue(env as Record<string, unknown>, ["name", "environment_name"], "");
            return isLikelyStagingEnvironmentName(name);
          }) as Record<string, unknown> | undefined;
        }
      }

      return {
        projectEndpointId,
        stagingEnvironmentId: stagingEnvironment
          ? stringValue(stagingEnvironment, ["uuid", "id"], "") || undefined
          : undefined,
        stagingEnvironmentName: stagingEnvironment
          ? stringValue(stagingEnvironment, ["name", "environment_name"], "") || undefined
          : undefined,
        created
      };
    } catch {
      return null;
    }
  };

  const createServiceFromSource = async (stagingEnvironment: StagingEnvironmentResolution): Promise<boolean> => {
    if (!stagingEnvironment.stagingEnvironmentId || !stagingEnvironment.stagingEnvironmentName) {
      return false;
    }

    let sourceService: Record<string, unknown> | null = null;
    try {
      const sourceServiceUuid = provisioningResource.kind === "service"
        ? provisioningResource.uuid
        : appUuid;
      const payload = await coolifyFetch(`/api/v1/services/${encodeURIComponent(sourceServiceUuid)}`);
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        sourceService = payload as Record<string, unknown>;
      }
    } catch {
      sourceService = null;
    }

    if (!sourceService) {
      return false;
    }

    // Coolify stopped exposing server_uuid on services and id on servers, which
    // silently broke this. See lib/coolify-server-resolve.ts for the rationale
    // and the tests; the decision itself is kept pure and out of this closure.
    let serverResolution: ServerResolution = { uuid: "", source: "unresolved" };
    const resolveServerUuid = async (): Promise<string> => {
      let servers: Array<Record<string, unknown>> = [];
      try {
        servers = ensureArray(await coolifyFetch("/api/v1/servers"));
      } catch {
        servers = [];
      }
      serverResolution = resolveStagingServerUuid({ service: sourceService, servers });
      return serverResolution.uuid;
    };

    const resolveDestinationUuid = async (serverUuid: string): Promise<string> => {
      const directDestinationUuid =
        stringValue(sourceService!, ["destination_uuid"], "") ||
        (typeof sourceService!.destination === "object" && sourceService!.destination !== null
          ? stringValue(sourceService!.destination as Record<string, unknown>, ["uuid"], "")
          : "");
      if (directDestinationUuid) {
        return directDestinationUuid;
      }

      const destinationId = stringValue(sourceService!, ["destination_id"], "");
      if (!destinationId || !serverUuid) {
        return "";
      }

      try {
        const serverPayload = await coolifyFetch(`/api/v1/servers/${encodeURIComponent(serverUuid)}`);
        if (!serverPayload || typeof serverPayload !== "object" || Array.isArray(serverPayload)) {
          return "";
        }

        const serverObj = serverPayload as Record<string, unknown>;
        const destinations = ensureArray(serverObj.destinations ?? serverObj.destination ?? []);
        const matched = destinations.find((destination) => stringValue(destination, ["id"], "") === destinationId);
        if (!matched) {
          return "";
        }

        return stringValue(matched, ["uuid"], "");
      } catch {
        return "";
      }
    };

    const resolvedProjectId =
      projectId ||
      stringValue(sourceService, ["project_uuid", "project_id", "project"], "");

    const serverUuid = await resolveServerUuid();
    const destinationUuid = await resolveDestinationUuid(serverUuid);
    const serviceType = stringValue(sourceService, ["service_type", "type"], "");
    const dockerComposeRaw = stringValue(sourceService, ["docker_compose_raw"], "");
    const sourceName = stringValue(sourceService, ["name"], "service");
    const preferredServiceNameSeed = normalizedPreferredDomain
      ? (() => {
          try {
            const host = new URL(normalizedPreferredDomain).hostname;
            return host.split(".")[0] || "";
          } catch {
            return "";
          }
        })()
      : "";

    if (!serverUuid || !resolvedProjectId) {
      // Record WHY. Returning false with no attempt logged is what made this
      // look like the toggle simply did nothing.
      provisioningAttempts.push({
        path: "/api/v1/services",
        method: "POST",
        ok: false,
        error: !serverUuid
          ? serverResolution.reason ?? "Could not determine which Coolify server to create the staging copy on."
          : "Could not determine which Coolify project the staging copy belongs to."
      });
      return false;
    }

    const baseBody: Record<string, unknown> = {
      name: buildStagingResourceName(preferredServiceNameSeed || sourceName),
      project_uuid: resolvedProjectId,
      environment_name: stagingEnvironment.stagingEnvironmentName,
      environment_uuid: stagingEnvironment.stagingEnvironmentId,
      server_uuid: serverUuid,
      instant_deploy: false
    };

    if (destinationUuid) {
      baseBody.destination_uuid = destinationUuid;
    }

    if (normalizedPreferredDomain) {
      // Intentionally omitting urls during creation.
      // Domain assignment is orchestrated separately to ensure deterministic convergence.
    }

    const candidateBodies: Record<string, unknown>[] = [];
    if (dockerComposeRaw) {
      // Coolify hands compose back as raw YAML but refuses it on the way in
      // unless base64 encoded, so posting it verbatim always 422'd and staging
      // fell through to the one-click template — a fresh service rather than a
      // copy of production.
      candidateBodies.push({
        ...baseBody,
        docker_compose_raw: encodeComposeForCoolify(dockerComposeRaw)
      });
    }
    if (serviceType) {
      candidateBodies.push({
        ...baseBody,
        type: serviceType
      });
    }

    if (candidateBodies.length === 0) {
      provisioningAttempts.push({
        path: "/api/v1/services",
        method: "POST",
        ok: false,
        error:
          "Coolify did not report a service type or compose file for this app, so there was nothing to copy for staging."
      });
      return false;
    }

    for (const body of candidateBodies) {
      const createResult = await coolifyMutateWithResponse("/api/v1/services", "POST", body);
      provisioningAttempts.push({
        path: "/api/v1/services",
        method: "POST",
        ok: createResult.ok,
        status: createResult.status,
        error: createResult.error
      });
      if (!createResult.ok) {
        continue;
      }

      return true;
    }

    return false;
  };

  const resourceUuid = encodeURIComponent(provisioningResource.uuid || appUuid);
  const serviceCandidateRequests: Array<{ path: string; body?: Record<string, unknown> }> = [
    {
      path: `/api/v1/services/${resourceUuid}/staging`,
      body: normalizedPreferredDomain
        ? { fqdn: normalizedPreferredDomain, domain: normalizedPreferredDomain }
        : undefined
    },
    {
      path: `/api/v1/services/${resourceUuid}/clone`,
      body: normalizedPreferredDomain
        ? { environment: "staging", fqdn: normalizedPreferredDomain, domain: normalizedPreferredDomain }
        : { environment: "staging" }
    },
    {
      path: `/api/v1/services/${resourceUuid}/duplicate`,
      body: normalizedPreferredDomain
        ? { environment: "staging", fqdn: normalizedPreferredDomain, domain: normalizedPreferredDomain }
        : { environment: "staging" }
    }
  ];
  const applicationCandidateRequests: Array<{ path: string; body?: Record<string, unknown> }> = [
    {
      path: `/api/v1/applications/${resourceUuid}/staging`,
      body: normalizedPreferredDomain
        ? { fqdn: normalizedPreferredDomain, domain: normalizedPreferredDomain }
        : undefined
    },
    {
      path: `/api/v1/applications/${resourceUuid}/clone`,
      body: normalizedPreferredDomain
        ? { environment: "staging", fqdn: normalizedPreferredDomain, domain: normalizedPreferredDomain }
        : { environment: "staging" }
    },
    {
      path: `/api/v1/applications/${resourceUuid}/duplicate`,
      body: normalizedPreferredDomain
        ? { environment: "staging", fqdn: normalizedPreferredDomain, domain: normalizedPreferredDomain }
        : { environment: "staging" }
    }
  ];

  const fallbackUuid = encodeURIComponent(appUuid);
  const fallbackCandidateRequests = provisioningResource.uuid !== appUuid
    ? [
        ...serviceCandidateRequests.map((request) => ({
          ...request,
          path: request.path.replace(resourceUuid, fallbackUuid)
        })),
        ...applicationCandidateRequests.map((request) => ({
          ...request,
          path: request.path.replace(resourceUuid, fallbackUuid)
        }))
      ]
    : [];

  const candidateRequests: Array<{ path: string; body?: Record<string, unknown> }> = provisioningResource.kind === "service"
    ? [...serviceCandidateRequests, ...applicationCandidateRequests, ...fallbackCandidateRequests]
    : provisioningResource.kind === "application"
      ? [...applicationCandidateRequests, ...serviceCandidateRequests, ...fallbackCandidateRequests]
      : [...serviceCandidateRequests, ...applicationCandidateRequests, ...fallbackCandidateRequests];

  for (const request of candidateRequests) {
    const result = await coolifyMutateWithResponse(request.path, "POST", request.body);
    provisioningAttempts.push({
      path: request.path,
      method: "POST",
      ok: result.ok,
      status: result.status,
      error: result.error
    });
    if (result.ok) {
      const verified = await verifyStagingTarget();
      return {
        mode: "live",
        ok: true,
        message: verified
          ? "Staging provisioning request sent to Coolify."
          : "Staging provisioning request was accepted by Coolify and is still settling.",
        reason: "request_sent",
        attempts: provisioningAttempts
      };
    }
  }

  const stagingEnvironment = await resolveStagingEnvironment();
  if (stagingEnvironment?.created) {
    const verifiedAfterCreate = await verifyStagingTarget();
    if (verifiedAfterCreate) {
      return {
        mode: "live",
        ok: true,
        message: "Staging environment created in Coolify.",
        reason: "environment_created",
        attempts: provisioningAttempts
      };
    }
  }

  if (stagingEnvironment) {
    const createdFromSource = await createServiceFromSource(stagingEnvironment);
    if (createdFromSource) {
      return {
        mode: "live",
        ok: true,
        message: "Staging target created in Coolify.",
        reason: "service_created",
        attempts: provisioningAttempts
      };
    }
  }

  if (projectId) {
    const ensuredEnvironment = await ensureCoolifyStagingEnvironment(projectId);
    if (ensuredEnvironment.ok && await verifyStagingTarget()) {
      return ensuredEnvironment;
    }
  }

  return {
    mode: "live",
    ok: false,
    message: "Automatic staging provisioning is unavailable for this app via current Coolify API routes. Provision staging manually in Coolify.",
    reason: "auto_provision_unsupported",
    attempts: provisioningAttempts
  };
}

export async function destroyCoolifyApplication(
  appUuid: string,
  resourceKind?: "application" | "service" | "database" | "unknown"
): Promise<CoolifyActionResult> {
  const baseUrl = process.env.COOLIFY_API_BASE_URL;
  const token = process.env.COOLIFY_API_TOKEN;

  if (!baseUrl || !token) {
    return {
      mode: "mock",
      ok: false,
      message: "Coolify credentials missing. Staging cannot be destroyed from this environment."
    };
  }

  const orderedKinds: Array<"application" | "service" | "database"> = resourceKind === "application"
    ? ["application", "service", "database"]
    : resourceKind === "service"
      ? ["service", "application", "database"]
      : resourceKind === "database"
        ? ["database", "application", "service"]
        : ["application", "service", "database"];

  const deletePathsByKind: Record<"application" | "service" | "database", string[]> = {
    application: [
      `/api/v1/applications/${encodeURIComponent(appUuid)}`,
      `/api/v1/resources/${encodeURIComponent(appUuid)}`
    ],
    service: [
      `/api/v1/services/${encodeURIComponent(appUuid)}`,
      `/api/v1/resources/${encodeURIComponent(appUuid)}`
    ],
    database: [
      `/api/v1/databases/${encodeURIComponent(appUuid)}`,
      `/api/v1/resources/${encodeURIComponent(appUuid)}`
    ]
  };

  for (const kind of orderedKinds) {
    for (const path of deletePathsByKind[kind]) {
      const ok = await coolifyMutate(path, "DELETE");
      if (!ok) {
        continue;
      }

      return {
        mode: "live",
        ok: true,
        message: "Staging target removed in Coolify.",
        reason: "resource_deleted"
      };
    }
  }

  // Some deployments expose delete semantics via POST action routes.
  const actionPaths = [
    `/api/v1/services/${encodeURIComponent(appUuid)}/delete`,
    `/api/v1/applications/${encodeURIComponent(appUuid)}/delete`
  ];

  for (const path of actionPaths) {
    const ok = await coolifyMutate(path, "POST");
    if (ok) {
      return {
        mode: "live",
        ok: true,
        message: "Staging target removed in Coolify.",
        reason: "resource_deleted"
      };
    }
  }

  const probePaths = [
    `/api/v1/applications/${encodeURIComponent(appUuid)}`,
    `/api/v1/services/${encodeURIComponent(appUuid)}`,
    `/api/v1/databases/${encodeURIComponent(appUuid)}`
  ];

  for (const path of probePaths) {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "GET",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`
        }
      });

      if (response.status === 404) {
        return {
          mode: "live",
          ok: true,
          message: "Staging target was already removed in Coolify.",
          reason: "resource_already_absent"
        };
      }
    } catch {
      // Ignore probe errors and continue.
    }
  }

  return {
    mode: "live",
    ok: false,
    message: "Unable to destroy staging target automatically. Remove it manually in Coolify.",
    reason: "auto_provision_unsupported"
  };
}

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
    const candidateRequests: Array<{ method: "GET" | "POST"; path: string }> = [
      { method: "GET", path: `/api/v1/services/${encodeURIComponent(serviceUuid)}/start` },
      { method: "POST", path: `/api/v1/services/${encodeURIComponent(serviceUuid)}/start` },
      { method: "GET", path: `/api/v1/deploy?uuid=${encodeURIComponent(serviceUuid)}` }
    ];

    let lastStatusCode = 0;
    for (const request of candidateRequests) {
      const startedAt = Date.now();
      const response = await fetch(`${baseUrl}${request.path}`, {
        method: request.method,
        cache: "no-store",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`
        },
        signal: controller.signal
      });

      if (!response.ok) {
        lastStatusCode = response.status;
        recordCoolifyEndpointCall({
          path: request.path,
          method: request.method,
          statusCode: response.status,
          success: false,
          durationMs: Date.now() - startedAt,
          error: `Coolify deploy candidate failed (${response.status})`
        });
        continue;
      }

      const payload = (await response.json()) as Record<string, unknown>;
      recordCoolifyEndpointCall({
        path: request.path,
        method: request.method,
        statusCode: response.status,
        success: true,
        responseCount: estimateResponseCount(payload),
        durationMs: Date.now() - startedAt
      });
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
    }

    throw new Error(`Coolify deploy failed (${lastStatusCode || 500})`);
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
  offsiteEnabled?: boolean;
  retentionAmount?: number;
  retentionDays?: number;
  lastBackupAt?: string;
  lastBackupStatus?: "success" | "failed" | "running" | "unknown";
};

export type BackupExecutionRecord = {
  id: string;
  resourceId?: string;
  resourceName?: string;
  status: "success" | "failed" | "running" | "unknown";
  startedAt?: string;
  finishedAt?: string;
  sizeBytes?: number;
  filename?: string;
  downloadUrl?: string;
  restoreUrl?: string;
};

export type DatabaseBackupCoverageRecord = {
  resourceId: string;
  resourceName: string;
  engine: "postgresql" | "mariadb" | "mysql" | "unknown";
  source: "standalone_database" | "embedded_service";
  hasSchedule: boolean;
  hasSuccessfulExecution: boolean;
  note?: string;
};

export type AppBackupInventory = {
  configured: boolean;
  schedules: BackupScheduleRecord[];
  recentExecutions: BackupExecutionRecord[];
  databaseCoverage: DatabaseBackupCoverageRecord[];
  source: "live" | "unavailable";
  note?: string;
  checkedAt: string;
};

export type BackupScheduleProvisionResult = {
  appUuid: string;
  checkedAt: string;
  attempted: boolean;
  configuredBefore: boolean;
  configuredAfter: boolean;
  targetDatabases: string[];
  updatedDatabases: string[];
  failedDatabases: string[];
  note?:
    | "missing_credentials"
    | "inventory_unavailable"
    | "already_configured"
    | "no_databases_detected"
    | "no_addressable_databases"
    | "service_databases_not_schedulable"
    | "provision_attempted"
    | "provision_failed";
};

// ─── Staging Capability Types ─────────────────────────────────────────────────

export type StagingCapabilityRecord = {
  detected: boolean;
  resourceKind?: "application" | "service" | "database" | "unknown";
  projectEnvNames?: string[];
  environmentId?: string;
  environmentName?: string;
  applicationUuid?: string;
  applicationName?: string;
  stagingUrl?: string;
  fqdn?: string;
  status?: "healthy" | "degraded" | "error" | "unknown";
  stagingCandidateCount?: number;
  stagingMatchedCandidateCount?: number;
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
  const enabled = raw.enabled === true || raw.is_enabled === true || raw.backup_enabled === true || raw.database_backup_enabled === true;
  const frequency = stringValue(raw, ["frequency", "cron", "schedule", "database_backup_cron", "database_backup_schedule"], "") || undefined;
  const offsiteEnabledRaw = raw.save_s3 ?? raw.save_to_s3 ?? raw.database_backup_save_s3 ?? raw.database_backup_save_to_s3;
  const offsiteEnabled = typeof offsiteEnabledRaw === "boolean"
    ? offsiteEnabledRaw
    : typeof offsiteEnabledRaw === "number"
      ? offsiteEnabledRaw !== 0
      : typeof offsiteEnabledRaw === "string"
        ? ["1", "true", "yes", "on"].includes(offsiteEnabledRaw.trim().toLowerCase())
        : undefined;
  const retentionAmount = typeof raw.database_backup_retention_amount_locally === "number"
    ? raw.database_backup_retention_amount_locally
    : typeof raw.retention_amount === "number" ? raw.retention_amount : undefined;
  const retentionDays = typeof raw.database_backup_retention_days_locally === "number"
    ? raw.database_backup_retention_days_locally
    : typeof raw.retention_days === "number" ? raw.retention_days : undefined;
  const lastBackupAt = stringValue(raw, ["last_backup_at", "latest_backup_at", "last_execution_at"], "") || undefined;

  let lastBackupStatus: BackupScheduleRecord["lastBackupStatus"] | undefined;
  const statusRaw = stringValue(raw, ["last_backup_status", "latest_backup_status", "status"], "").toLowerCase();
  if (statusRaw.includes("success") || statusRaw.includes("complete") || statusRaw.includes("finish")) {
    lastBackupStatus = "success";
  } else if (statusRaw.includes("fail") || statusRaw.includes("error")) {
    lastBackupStatus = "failed";
  } else if (statusRaw.includes("run") || statusRaw.includes("pending") || statusRaw.includes("queue")) {
    lastBackupStatus = "running";
  }

  return {
    id,
    resourceId,
    resourceName,
    resourceType: "database",
    enabled,
    frequency,
    offsiteEnabled,
    retentionAmount,
    retentionDays,
    lastBackupAt,
    lastBackupStatus
  };
}

function toAbsoluteCoolifyUrl(raw: string): string {
  const value = raw.trim();
  if (!value) {
    return "";
  }

  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }

  const baseUrl = process.env.COOLIFY_API_BASE_URL?.trim() || "";
  if (!baseUrl) {
    return value;
  }

  return `${baseUrl.replace(/\/+$/, "")}/${value.replace(/^\/+/, "")}`;
}

function normalizeBackupExecution(raw: Record<string, unknown>, resourceId?: string, resourceName?: string): BackupExecutionRecord {
  const id = stringValue(raw, ["id", "uuid"], `exec-${Date.now()}`);
  const statusRaw = stringValue(raw, ["status", "result", "state", "last_status"], "").toLowerCase();
  const successRaw = raw.success === true || raw.is_successful === true;
  const failureRaw = raw.success === false || raw.is_successful === false;
  let status: BackupExecutionRecord["status"] = "unknown";
  if (successRaw || statusRaw.includes("success") || statusRaw.includes("finish") || statusRaw.includes("complet")) {
    status = "success";
  } else if (failureRaw || statusRaw.includes("fail") || statusRaw.includes("error")) {
    status = "failed";
  } else if (statusRaw.includes("run") || statusRaw.includes("pending") || statusRaw.includes("in_progress")) {
    status = "running";
  }
  const startedAt = stringValue(raw, ["started_at", "created_at", "createdAt"], "") || undefined;
  const finishedAt = stringValue(raw, ["finished_at", "updated_at", "completed_at", "finishedAt"], "") || undefined;
  const sizeBytes = typeof raw.size === "number" ? raw.size : undefined;
  const filename = stringValue(raw, ["filename", "file_name", "dump_file", "backup_file", "path"], "") || undefined;
  const downloadRaw = stringValue(raw, ["download_url", "downloadUrl", "url"], "");
  const restoreRaw = stringValue(raw, ["restore_url", "restoreUrl"], "");
  const downloadUrl = downloadRaw ? toAbsoluteCoolifyUrl(downloadRaw) : undefined;
  const restoreUrl = restoreRaw ? toAbsoluteCoolifyUrl(restoreRaw) : undefined;
  return { id, resourceId, resourceName, status, startedAt, finishedAt, sizeBytes, filename, downloadUrl, restoreUrl };
}

function extractBackupRows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return ensureArray(payload);
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  const objectPayload = payload as Record<string, unknown>;
  const candidateKeys = ["data", "items", "results", "backups", "schedules", "snapshots", "executions"];

  for (const key of candidateKeys) {
    const value = objectPayload[key];
    if (Array.isArray(value)) {
      return ensureArray(value);
    }
  }

  return [];
}

function hasScheduleSignal(raw: Record<string, unknown>): boolean {
  return Boolean(
    raw.enabled === true ||
      raw.is_enabled === true ||
      raw.backup_enabled === true ||
      raw.database_backup_enabled === true ||
      stringValue(raw, ["frequency", "cron", "schedule", "database_backup_cron", "database_backup_schedule"], "")
  );
}

function hasExecutionSignal(raw: Record<string, unknown>): boolean {
  return Boolean(
    stringValue(raw, ["status", "result", "state", "last_status"], "") ||
      stringValue(raw, ["filename", "file_name", "dump_file", "backup_file", "path"], "") ||
      stringValue(raw, ["finished_at", "completed_at", "started_at", "created_at"], "") ||
      typeof raw.success === "boolean" ||
      typeof raw.is_successful === "boolean"
  );
}

async function collectDatabaseBackupTelemetry(
  dbId: string,
  dbName: string,
  schedules: BackupScheduleRecord[],
  recentExecutions: BackupExecutionRecord[]
): Promise<void> {
  if (!dbId) {
    return;
  }

  const backupPayload = await coolifyFetch(`/api/v1/databases/${dbId}/backups`);
  const backupRows = extractBackupRows(backupPayload);

  for (const row of backupRows) {
    if (!row || typeof row !== "object") {
      continue;
    }

    const record = row as Record<string, unknown>;
    if (hasScheduleSignal(record)) {
      schedules.push(normalizeBackupSchedule(record, dbId, dbName));
    }

    if (hasExecutionSignal(record)) {
      recentExecutions.push(normalizeBackupExecution(record, dbId, dbName));
    }

    const nestedExecutions = ensureArray(record.executions ?? record.backup_executions ?? record.history ?? record.runs ?? []);
    for (const execution of nestedExecutions.slice(0, 20)) {
      if (!execution || typeof execution !== "object") {
        continue;
      }
      recentExecutions.push(normalizeBackupExecution(execution as Record<string, unknown>, dbId, dbName));
    }
  }
}

function backupProvisionDefaults(): { cron: string; retentionAmount: number; retentionDays: number } {
  const cron = (process.env.COOLIFY_DEFAULT_BACKUP_CRON || "0 2 * * *").trim() || "0 2 * * *";
  const retentionAmountRaw = Number(process.env.COOLIFY_DEFAULT_BACKUP_RETENTION_AMOUNT || 7);
  const retentionDaysRaw = Number(process.env.COOLIFY_DEFAULT_BACKUP_RETENTION_DAYS || 7);

  return {
    cron,
    retentionAmount: Number.isFinite(retentionAmountRaw) && retentionAmountRaw > 0 ? Math.floor(retentionAmountRaw) : 7,
    retentionDays: Number.isFinite(retentionDaysRaw) && retentionDaysRaw > 0 ? Math.floor(retentionDaysRaw) : 7
  };
}

async function tryApplyDatabaseBackupSchedule(
  databaseId: string,
  defaults: { cron: string; retentionAmount: number; retentionDays: number }
): Promise<boolean> {
  const payloadBackupsCreate = {
    frequency: defaults.cron,
    enabled: true,
    save_s3: false
  };

  const payloadPrimary = {
    database_backup_enabled: true,
    database_backup_cron: defaults.cron,
    database_backup_retention_amount_locally: defaults.retentionAmount,
    database_backup_retention_days_locally: defaults.retentionDays
  };

  const payloadFallback = {
    backup_enabled: true,
    enabled: true,
    cron: defaults.cron,
    schedule: defaults.cron,
    retention_amount: defaults.retentionAmount,
    retention_days: defaults.retentionDays
  };

  const attempts: Array<{
    path: string;
    method: "POST" | "PATCH" | "PUT";
    body: Record<string, unknown>;
  }> = [
    { path: `/api/v1/databases/${encodeURIComponent(databaseId)}/backups`, method: "POST", body: payloadBackupsCreate },
    { path: `/api/v1/databases/${encodeURIComponent(databaseId)}`, method: "PATCH", body: payloadPrimary },
    { path: `/api/v1/databases/${encodeURIComponent(databaseId)}/settings`, method: "PATCH", body: payloadPrimary },
    { path: `/api/v1/databases/${encodeURIComponent(databaseId)}/backups`, method: "POST", body: payloadPrimary },
    { path: `/api/v1/databases/${encodeURIComponent(databaseId)}/backups`, method: "PATCH", body: payloadPrimary },
    { path: `/api/v1/databases/${encodeURIComponent(databaseId)}/backups`, method: "PUT", body: payloadPrimary },
    { path: `/api/v1/databases/${encodeURIComponent(databaseId)}`, method: "PATCH", body: payloadFallback },
    { path: `/api/v1/databases/${encodeURIComponent(databaseId)}/settings`, method: "PATCH", body: payloadFallback },
    { path: `/api/v1/databases/${encodeURIComponent(databaseId)}/backups`, method: "POST", body: payloadFallback }
  ];

  for (const attempt of attempts) {
    const response = await coolifyMutateWithResponse(attempt.path, attempt.method, attempt.body);
    if (response.ok) {
      return true;
    }
  }

  return false;
}

export async function ensureCoolifyAppBackupSchedules(appUuid: string): Promise<BackupScheduleProvisionResult> {
  const checkedAt = new Date().toISOString();
  const baseUrl = process.env.COOLIFY_API_BASE_URL;
  const token = process.env.COOLIFY_API_TOKEN;
  if (!baseUrl || !token) {
    return {
      appUuid,
      checkedAt,
      attempted: false,
      configuredBefore: false,
      configuredAfter: false,
      targetDatabases: [],
      updatedDatabases: [],
      failedDatabases: [],
      note: "missing_credentials"
    };
  }

  const inventoryBefore = await getCoolifyAppBackupInventory(appUuid);
  if (inventoryBefore.source !== "live") {
    return {
      appUuid,
      checkedAt,
      attempted: false,
      configuredBefore: inventoryBefore.configured,
      configuredAfter: inventoryBefore.configured,
      targetDatabases: [],
      updatedDatabases: [],
      failedDatabases: [],
      note: "inventory_unavailable"
    };
  }

  const missingCoverage = inventoryBefore.databaseCoverage.filter((item) => !item.hasSchedule);
  const configuredBefore = inventoryBefore.configured && missingCoverage.length === 0;
  if (configuredBefore) {
    return {
      appUuid,
      checkedAt,
      attempted: false,
      configuredBefore: true,
      configuredAfter: true,
      targetDatabases: [],
      updatedDatabases: [],
      failedDatabases: [],
      note: "already_configured"
    };
  }

  if (inventoryBefore.databaseCoverage.length === 0) {
    return {
      appUuid,
      checkedAt,
      attempted: false,
      configuredBefore: false,
      configuredAfter: inventoryBefore.configured,
      targetDatabases: [],
      updatedDatabases: [],
      failedDatabases: [],
      note: "no_databases_detected"
    };
  }

  // Coolify's API cannot schedule backups for service-EMBEDDED databases (a
  // WordPress site's MariaDB): queryDatabaseByUuidWithinTeam() only iterates
  // STANDALONE_DATABASE_MODELS, so POST /databases/<service-db-uuid>/backups
  // answers 404 "Database not found". Attempting them anyway produced a
  // permanent provision_failed for every WordPress site and masked the real
  // failures. These sites are protected by jongo's own full-site backups
  // (files + database to Backblaze) instead, so skip rather than fail.
  const serviceDatabasesMissing = missingCoverage.filter((item) => item.source === "embedded_service");
  const schedulableMissing = missingCoverage.filter((item) => item.source !== "embedded_service");

  const databaseIds = [...new Set(
    schedulableMissing
      .map((item) => item.resourceId)
      .filter((value) => value && !value.startsWith("service:"))
  )];

  if (databaseIds.length === 0) {
    return {
      appUuid,
      checkedAt,
      attempted: false,
      configuredBefore: inventoryBefore.configured,
      configuredAfter: inventoryBefore.configured,
      targetDatabases: [],
      updatedDatabases: [],
      failedDatabases: [],
      note: serviceDatabasesMissing.length > 0
        ? "service_databases_not_schedulable"
        : "no_addressable_databases"
    };
  }

  const defaults = backupProvisionDefaults();
  const updatedDatabases: string[] = [];
  const failedDatabases: string[] = [];

  for (const databaseId of databaseIds) {
    const ok = await tryApplyDatabaseBackupSchedule(databaseId, defaults);
    if (ok) {
      updatedDatabases.push(databaseId);
    } else {
      failedDatabases.push(databaseId);
    }
  }

  const inventoryAfter = await getCoolifyAppBackupInventory(appUuid);
  // Judge success only on databases Coolify can actually schedule; a leftover
  // service-embedded database is expected, not a failure.
  const missingAfter = inventoryAfter.databaseCoverage.filter(
    (item) => !item.hasSchedule && item.source !== "embedded_service"
  );
  const configuredAfter = missingAfter.length === 0;

  return {
    appUuid,
    checkedAt,
    attempted: true,
    configuredBefore,
    configuredAfter,
    targetDatabases: databaseIds,
    updatedDatabases,
    failedDatabases,
    note: configuredAfter ? "provision_attempted" : "provision_failed"
  };
}

function normalizeDatabaseEngine(raw: Record<string, unknown>): DatabaseBackupCoverageRecord["engine"] {
  const engineRaw = stringValue(raw, ["database_type", "engine", "type", "resource_type", "service_type", "custom_type", "image", "name"], "").toLowerCase();
  if (engineRaw.includes("postgres")) return "postgresql";
  if (engineRaw.includes("mariadb")) return "mariadb";
  if (engineRaw.includes("mysql")) return "mysql";
  return "unknown";
}

function detectEmbeddedDatabaseFromService(service: Record<string, unknown>): {
  engine: DatabaseBackupCoverageRecord["engine"];
  note?: string;
} | null {
  const serviceType = stringValue(service, ["service_type", "type"], "").toLowerCase();
  const composeRaw = `${stringValue(service, ["docker_compose", "docker_compose_raw"], "")}`.toLowerCase();

  if (serviceType.includes("wordpress-with-mariadb")) {
    return {
      engine: "mariadb",
      note: "WordPress with embedded MariaDB service. No standalone database schedule detected."
    };
  }

  if (serviceType.includes("wordpress-with-mysql")) {
    return {
      engine: "mysql",
      note: "WordPress with embedded MySQL service. No standalone database schedule detected."
    };
  }

  if (composeRaw.includes("image: mariadb") || composeRaw.includes(" mariadb:")) {
    return {
      engine: "mariadb",
      note: "Embedded MariaDB detected in service compose. No standalone database schedule detected."
    };
  }

  if (composeRaw.includes("image: mysql") || composeRaw.includes(" mysql:")) {
    return {
      engine: "mysql",
      note: "Embedded MySQL detected in service compose. No standalone database schedule detected."
    };
  }

  return null;
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
    return {
      configured: false,
      schedules: [],
      recentExecutions: [],
      databaseCoverage: [],
      source: "unavailable",
      note: "missing_credentials",
      checkedAt
    };
  }

  try {
    // Step 1: Fetch the application to find its environment_id
    let appRaw: Record<string, unknown> | null = null;
    let serviceRaw: Record<string, unknown> | null = null;
    let applicationLookupFailed = false;
    try {
      const payload = await coolifyFetch(`/api/v1/applications/${appUuid}`);
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        appRaw = payload as Record<string, unknown>;
      }
    } catch {
      applicationLookupFailed = true;
    }

    if (!appRaw) {
      try {
        const payload = await coolifyFetch(`/api/v1/services/${appUuid}`);
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
          serviceRaw = payload as Record<string, unknown>;
        }
      } catch {
        // Best effort
      }
    }

    const schedules: BackupScheduleRecord[] = [];
    const recentExecutions: BackupExecutionRecord[] = [];
    const databaseCoverageByResourceId = new Map<string, DatabaseBackupCoverageRecord>();
    let backupFetchAttempts = 0;
    let backupFetchFailures = 0;

    // Step 2: Try to get databases in the same project/environment
    const rootResource = appRaw ?? serviceRaw;
    const projectId = rootResource
      ? stringValue(rootResource, ["project_uuid", "project_id", "project"], "")
      : "";
    const environmentId = rootResource
      ? stringValue(rootResource, ["environment_id", "environment_uuid", "environment"], "")
      : "";

    let databases: Record<string, unknown>[] = [];

    // Some Coolify setups attach database metadata directly on the application payload.
    if (appRaw) {
      databases = ensureArray(
        appRaw.databases ??
          appRaw.standalone_postgresqls ??
          appRaw.standalone_mariadbs ??
          appRaw.standalone_mysqls ??
          appRaw.postgresqls ??
          appRaw.mariadbs ??
          appRaw.mysqls ??
          appRaw.database ??
          appRaw.attached_databases ??
          []
      );
    }

    if (databases.length === 0 && serviceRaw) {
      databases = ensureArray(
        serviceRaw.databases ??
          serviceRaw.service_databases ??
          serviceRaw.standalone_postgresqls ??
          serviceRaw.standalone_mariadbs ??
          serviceRaw.standalone_mysqls ??
          serviceRaw.postgresqls ??
          serviceRaw.mariadbs ??
          serviceRaw.mysqls ??
          []
      );
    }

    if (databases.length === 0 && projectId && environmentId) {
      try {
        const envPayload = await coolifyFetch(`/api/v1/projects/${projectId}/environments/${environmentId}`);
        const envObj = envPayload && typeof envPayload === "object" && !Array.isArray(envPayload)
          ? (envPayload as Record<string, unknown>)
          : {};
        databases = ensureArray(
          envObj.databases ??
            envObj.standalone_postgresqls ??
            envObj.standalone_mariadbs ??
            envObj.standalone_mysqls ??
            envObj.postgresqls ??
            envObj.mariadbs ??
            envObj.mysqls ??
            envObj.attached_databases ??
            []
        );
      } catch {
        // Best effort
      }
    }

    // Fallback: some projects expose databases only via the global databases endpoint.
    if (databases.length === 0 && (projectId || environmentId)) {
      try {
        const allDatabasesPayload = await coolifyFetch(`/api/v1/databases`);
        const allDatabases = ensureArray(allDatabasesPayload);

        const projectDatabases = allDatabases.filter((db) => {
          const record = (db && typeof db === "object" ? db : {}) as Record<string, unknown>;
          const dbProject = stringValue(record, ["project_uuid", "project_id", "project"], "");
          return projectId ? dbProject === projectId : false;
        });

        if (projectDatabases.length > 0) {
          databases = projectDatabases;
        } else if (environmentId) {
          const environmentDatabases = allDatabases.filter((db) => {
            const record = (db && typeof db === "object" ? db : {}) as Record<string, unknown>;
            const dbEnv = stringValue(record, ["environment_id", "environment_uuid", "environment"], "");
            return dbEnv === environmentId;
          });
          databases = environmentDatabases;
        }
      } catch {
        // Best effort
      }
    }

    for (const db of databases) {
      const dbId = stringValue(db, ["uuid", "id"], "");
      if (!dbId) {
        continue;
      }

      const dbName = stringValue(db, ["name", "database_name"], dbId);
      const isServiceDatabase = typeof db.service_id === "number" || typeof db.service_id === "string";
      databaseCoverageByResourceId.set(dbId, {
        resourceId: dbId,
        resourceName: dbName,
        engine: normalizeDatabaseEngine(db),
        source: isServiceDatabase ? "embedded_service" : "standalone_database",
        hasSchedule: false,
        hasSuccessfulExecution: false
      });
    }

    if (serviceRaw && databases.length === 0) {
      const embeddedDatabase = detectEmbeddedDatabaseFromService(serviceRaw);
      if (embeddedDatabase) {
        const serviceName = stringValue(serviceRaw, ["name"], appUuid);
        const serviceId = stringValue(serviceRaw, ["uuid", "id"], appUuid);
        const coverageId = `service:${serviceId}:${embeddedDatabase.engine}`;
        databaseCoverageByResourceId.set(coverageId, {
          resourceId: coverageId,
          resourceName: `${serviceName} (${embeddedDatabase.engine})`,
          engine: embeddedDatabase.engine,
          source: "embedded_service",
          hasSchedule: false,
          hasSuccessfulExecution: false,
          note: embeddedDatabase.note
        });
      }
    }

    // Step 3: For each database, attempt to read its backup config
    for (const db of databases.slice(0, 5)) {
      const dbId = stringValue(db, ["uuid", "id"], "");
      const dbName = stringValue(db, ["name", "database_name"], dbId);
      if (!dbId) continue;

      backupFetchAttempts += 1;
      try {
        await collectDatabaseBackupTelemetry(dbId, dbName, schedules, recentExecutions);
      } catch {
        // Backup endpoint unavailable for this database
        backupFetchFailures += 1;
      }
    }

    // Step 4: If this resource is a database site, query it directly.
    if (databases.length === 0 && applicationLookupFailed) {
      backupFetchAttempts += 1;
      try {
        await collectDatabaseBackupTelemetry(appUuid, appUuid, schedules, recentExecutions);
      } catch {
        // Best effort
        backupFetchFailures += 1;
      }
    }

    const dedupedSchedules = new Map<string, BackupScheduleRecord>();
    for (const schedule of schedules) {
      const key = `${schedule.resourceId}:${schedule.id}`;
      if (!dedupedSchedules.has(key)) {
        dedupedSchedules.set(key, schedule);
      }
    }

    const dedupedExecutions = new Map<string, BackupExecutionRecord>();
    for (const execution of recentExecutions) {
      const key = `${execution.resourceId ?? "unknown"}:${execution.id}:${execution.filename ?? ""}`;
      if (!dedupedExecutions.has(key)) {
        dedupedExecutions.set(key, execution);
      }
    }

    const normalizedExecutions = [...dedupedExecutions.values()].sort((left, right) => {
      const rightTs = new Date(right.finishedAt ?? right.startedAt ?? 0).getTime();
      const leftTs = new Date(left.finishedAt ?? left.startedAt ?? 0).getTime();
      return rightTs - leftTs;
    });

    const normalizedSchedules = [...dedupedSchedules.values()];
    for (const schedule of normalizedSchedules) {
      const coverage = databaseCoverageByResourceId.get(schedule.resourceId);
      if (coverage && schedule.enabled) {
        coverage.hasSchedule = true;
      }
    }

    for (const execution of normalizedExecutions) {
      if (!execution.resourceId) {
        continue;
      }
      const coverage = databaseCoverageByResourceId.get(execution.resourceId);
      if (coverage && execution.status === "success") {
        coverage.hasSuccessfulExecution = true;
      }
    }

    const databaseCoverage = [...databaseCoverageByResourceId.values()];
    const configured = normalizedSchedules.some((s) => s.enabled);
    const missingSchedules = databaseCoverage.filter((item) => !item.hasSchedule);
    const hasAnyCoverage = databaseCoverage.length > 0;
    const backupTelemetryEndpointUnavailable =
      backupFetchAttempts > 0 &&
      backupFetchFailures >= backupFetchAttempts &&
      normalizedSchedules.length === 0 &&
      normalizedExecutions.length === 0;

    let note: string | undefined;
    if (backupTelemetryEndpointUnavailable) {
      note = "backup_telemetry_unavailable";
    } else if (normalizedSchedules.length === 0 && normalizedExecutions.length === 0) {
      note = databases.length === 0 ? "no_databases_in_environment" : "backups_not_configured";
    } else if (hasAnyCoverage && missingSchedules.length === databaseCoverage.length) {
      note = "backups_not_configured";
    } else if (hasAnyCoverage && missingSchedules.length > 0) {
      note = "partial_backup_coverage";
    }

    return {
      configured,
      schedules: normalizedSchedules,
      recentExecutions: normalizedExecutions.slice(0, 40),
      databaseCoverage,
      source: "live",
      note,
      checkedAt
    };
  } catch {
    return {
      configured: false,
      schedules: [],
      recentExecutions: [],
      databaseCoverage: [],
      source: "unavailable",
      note: "fetch_error",
      checkedAt
    };
  }
}

// ─── Staging Capability Detection ────────────────────────────────────────────

/**
 * Detect staging capability for a given Coolify application.
 * Looks for a staging environment in the same project and for a staging application.
 * Read-only – never creates or modifies resources.
 */
export async function getCoolifyAppStagingCapability(
  appUuid: string,
  projectId?: string,
  options?: { relaxedTargetMatch?: boolean }
): Promise<StagingCapabilityRecord> {
  const baseUrl = process.env.COOLIFY_API_BASE_URL;
  const token = process.env.COOLIFY_API_TOKEN;
  const checkedAt = new Date().toISOString();
  const relaxedTargetMatch = Boolean(options?.relaxedTargetMatch);

  if (!baseUrl || !token) {
    return { detected: false, note: "missing_credentials", checkedAt };
  }

  try {
    const normalizeStagingNameKey = (value: string): string =>
      value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");

    const stripStageHints = (value: string): string =>
      value
        .replace(/-(staging|stage|preview|dev|development|prod|production)$/g, "")
        .replace(/-(staging|stage|preview|dev|development|prod|production)$/g, "")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");

    const extractResourceName = (value: Record<string, unknown> | null | undefined): string =>
      value ? stringValue(value, ["name", "application_name", "service_name"], "") : "";

    const isLikelyStagingSibling = (candidate: Record<string, unknown>): boolean => {
      const rootResourceKey = stripStageHints(normalizeStagingNameKey(extractResourceName(rootResource)));
      const candidateKey = stripStageHints(normalizeStagingNameKey(extractResourceName(candidate)));

      if (!candidateKey || !rootResourceKey) {
        return true;
      }

      if (candidateKey === rootResourceKey) {
        return true;
      }

      if (rootResourceKey.length >= 4 && candidateKey.includes(rootResourceKey)) {
        return true;
      }

      if (candidateKey.length >= 4 && rootResourceKey.includes(candidateKey)) {
        return true;
      }

      return false;
    };

    const pickBestStagingTarget = (candidates: Record<string, unknown>[]): {
      selected?: Record<string, unknown>;
      candidateCount: number;
      matchedCount: number;
    } => {
      const sanitized = candidates.filter((candidate) => {
        const candidateUuid = stringValue(candidate, ["uuid", "id"], "");
        return candidateUuid.length > 0 && candidateUuid !== appUuid;
      });

      const matched = sanitized.filter((candidate) => isLikelyStagingSibling(candidate));
      if (matched.length === 0 && relaxedTargetMatch && sanitized.length === 1) {
        return {
          selected: sanitized[0],
          candidateCount: sanitized.length,
          matchedCount: matched.length
        };
      }

      return {
        selected: matched[0],
        candidateCount: sanitized.length,
        matchedCount: matched.length
      };
    };

    let resourceKind: StagingCapabilityRecord["resourceKind"] = "unknown";
    let rootResource: Record<string, unknown> | null = null;

    const resourceLookups: Array<{
      kind: NonNullable<StagingCapabilityRecord["resourceKind"]>;
      path: string;
    }> = [
      { kind: "application", path: `/api/v1/applications/${appUuid}` },
      { kind: "service", path: `/api/v1/services/${appUuid}` },
      { kind: "database", path: `/api/v1/databases/${appUuid}` }
    ];

    for (const lookup of resourceLookups) {
      try {
        const payload = await coolifyFetch(lookup.path);
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
          rootResource = payload as Record<string, unknown>;
          resourceKind = lookup.kind;
          break;
        }
      } catch {
        // Try the next resource class.
      }
    }

    // Resolve project if not supplied
    let resolvedProjectId = projectId;
    if (!resolvedProjectId) {
      if (rootResource) {
        resolvedProjectId = stringValue(rootResource, ["project_uuid", "project_id", "project"], "");
      }
      if (!resolvedProjectId) {
        return {
          detected: false,
          resourceKind,
          note: rootResource ? "no_project_resolved" : "resource_not_found",
          checkedAt
        };
      }
    }

    if (!resolvedProjectId) {
      return { detected: false, resourceKind, note: "no_project_resolved", checkedAt };
    }

    // Get all environments for the project
    const projectEndpointId = await resolveCoolifyProjectEndpointId(resolvedProjectId);
    const projectPayload = await coolifyFetch(`/api/v1/projects/${projectEndpointId}`);
    const projectObj = projectPayload && typeof projectPayload === "object" && !Array.isArray(projectPayload)
      ? (projectPayload as Record<string, unknown>)
      : {};
    const environments = ensureArray(projectObj.environments ?? []);
    const projectEnvNames = environments
      .map((env) => stringValue(env as Record<string, unknown>, ["name", "environment_name"], ""))
      .filter((name) => name.length > 0);

    const stagingEnv = environments.find((env) => {
      const name = stringValue(env as Record<string, unknown>, ["name"], "").toLowerCase();
      return name.includes("stag") || name.includes("preview") || name === "dev";
    });

    if (!stagingEnv) {
      const note = projectEnvNames.length > 0 && projectEnvNames.every((name) => name.toLowerCase().includes("prod"))
        ? "project_only_has_production_environment"
        : "no_staging_environment_in_project";
      return { detected: false, resourceKind, projectEnvNames, note, checkedAt };
    }

    const stagingEnvObj = stagingEnv as Record<string, unknown>;
    const stagingEnvId = stringValue(stagingEnvObj, ["id", "uuid"], "");
    const stagingEnvName = stringValue(stagingEnvObj, ["name"], "staging");
    const projectIdCandidates = new Set<string>([resolvedProjectId, projectEndpointId].filter(Boolean));

    // Look for an application in the staging environment
    const stagingApplications = ensureArray(stagingEnvObj.applications ?? []);
    let stagingApp: Record<string, unknown> | undefined;
    let stagingService: Record<string, unknown> | undefined;
    let stagingCandidateCount = 0;
    let stagingMatchedCandidateCount = 0;

    const initialAppPick = pickBestStagingTarget(stagingApplications);
    stagingApp = initialAppPick.selected;
    stagingCandidateCount = initialAppPick.candidateCount;
    stagingMatchedCandidateCount = initialAppPick.matchedCount;

    // Some Coolify project payloads omit nested applications for environments.
    // Fall back to scanning the application inventory by environment ID/name.
    if (!stagingApp) {
      try {
        const applicationsPayload = await coolifyFetch("/api/v1/applications");
        const applications = ensureArray(applicationsPayload);
        const normalizedStagingEnvName = stagingEnvName.trim().toLowerCase();

        const candidateApplications = applications.filter((app) => {
          const appEnvId = stringValue(app, ["environment_id", "environmentId", "environment_uuid"], "");
          const appEnvName = stringValue(app, ["environment_name", "environment"], "").trim().toLowerCase();
          const appProjectId = stringValue(app, ["project_uuid", "project_id", "project"], "");
          const appDeletedAt = stringValue(app, ["deleted_at"], "");

          const matchesEnvironment =
            (stagingEnvId.length > 0 && appEnvId === stagingEnvId) ||
            (normalizedStagingEnvName.length > 0 && appEnvName === normalizedStagingEnvName);

          if (!matchesEnvironment) {
            return false;
          }

          if (appDeletedAt.length > 0) {
            return false;
          }

          if (projectIdCandidates.size === 0 || appProjectId.length === 0) {
            return true;
          }

          return projectIdCandidates.has(appProjectId);
        });

        const picked = pickBestStagingTarget(candidateApplications);
        stagingApp = picked.selected;
        stagingCandidateCount = Math.max(stagingCandidateCount, picked.candidateCount);
        stagingMatchedCandidateCount = Math.max(stagingMatchedCandidateCount, picked.matchedCount);
      } catch {
        // Keep reporting environment-only staging if list endpoint cannot be fetched.
      }
    }

    // Service resources can expose staging targets as services without a nested applications entry.
    if (!stagingApp && resourceKind === "service") {
      const stagingServices = ensureArray(stagingEnvObj.services ?? []);
      const initialServicePick = pickBestStagingTarget(stagingServices);
      stagingService = initialServicePick.selected;
      stagingCandidateCount = Math.max(stagingCandidateCount, initialServicePick.candidateCount);
      stagingMatchedCandidateCount = Math.max(stagingMatchedCandidateCount, initialServicePick.matchedCount);

      if (!stagingService) {
        try {
          const servicesPayload = await coolifyFetch("/api/v1/services");
          const services = ensureArray(servicesPayload);
          const normalizedStagingEnvName = stagingEnvName.trim().toLowerCase();

          const candidateServices = services.filter((service) => {
            const serviceEnvId = stringValue(service, ["environment_id", "environmentId", "environment_uuid"], "");
            const serviceEnvName = stringValue(service, ["environment_name", "environment"], "").trim().toLowerCase();
            const serviceProjectId = stringValue(service, ["project_uuid", "project_id", "project"], "");
            const serviceDeletedAt = stringValue(service, ["deleted_at"], "");

            const matchesEnvironment =
              (stagingEnvId.length > 0 && serviceEnvId === stagingEnvId) ||
              (normalizedStagingEnvName.length > 0 && serviceEnvName === normalizedStagingEnvName);

            if (!matchesEnvironment) {
              return false;
            }

            if (serviceDeletedAt.length > 0) {
              return false;
            }

            if (projectIdCandidates.size === 0 || serviceProjectId.length === 0) {
              return true;
            }

            return projectIdCandidates.has(serviceProjectId);
          });

          const picked = pickBestStagingTarget(candidateServices);
          stagingService = picked.selected;
          stagingCandidateCount = Math.max(stagingCandidateCount, picked.candidateCount);
          stagingMatchedCandidateCount = Math.max(stagingMatchedCandidateCount, picked.matchedCount);
        } catch {
          // Keep reporting environment-only staging if list endpoint cannot be fetched.
        }
      }
    }

    const resolvedStagingTarget = stagingApp ?? stagingService;

    if (!resolvedStagingTarget) {
      const note = stagingCandidateCount > 0 && stagingMatchedCandidateCount === 0
        ? "staging_environment_exists_for_other_resource"
        : "staging_environment_exists_no_application";
      return {
        detected: true,
        resourceKind,
        projectEnvNames,
        environmentId: stagingEnvId,
        environmentName: stagingEnvName,
        stagingCandidateCount,
        stagingMatchedCandidateCount,
        note,
        checkedAt
      };
    }

    const stagingAppUuid = stringValue(resolvedStagingTarget, ["uuid", "id"], "");
    const defaultTargetName = resourceKind === "service" ? "staging service" : "staging app";
    const stagingAppName = stringValue(resolvedStagingTarget, ["name"], defaultTargetName);
    let detailedStagingTarget = resolvedStagingTarget;
    const detailPath = resourceKind === "service"
      ? `/api/v1/services/${encodeURIComponent(stagingAppUuid)}`
      : `/api/v1/applications/${encodeURIComponent(stagingAppUuid)}`;

    if (stagingAppUuid) {
      try {
        const detailPayload = await coolifyFetch(detailPath);
        if (detailPayload && typeof detailPayload === "object" && !Array.isArray(detailPayload)) {
          detailedStagingTarget = detailPayload as Record<string, unknown>;
        }
      } catch {
        // Keep list payload fallback when detail endpoint is unavailable.
      }
    }

    const stagingDomains = extractStagingDomainList(detailedStagingTarget);
    const fqdn = stagingDomains.join(",") || undefined;
    const stagingUrl = stagingDomains[0] || undefined;
    const status = statusFromRaw(
      detailedStagingTarget.status ??
      detailedStagingTarget.current_status ??
      detailedStagingTarget.server_status
    );

    return {
      detected: true,
      resourceKind,
      projectEnvNames,
      environmentId: stagingEnvId,
      environmentName: stagingEnvName,
      applicationUuid: stagingAppUuid || undefined,
      applicationName: stagingAppName || undefined,
      stagingUrl,
      fqdn,
      status,
      stagingCandidateCount,
      stagingMatchedCandidateCount,
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
    const hasEnvironmentOnlyStaging = Boolean(stagingCapability.detected && !stagingCapability.applicationUuid);
    return {
      source,
      target: null,
      databaseBehavior: "unknown",
      filesBehavior: "unknown",
      domainBehavior: "unknown",
      risks: [
        hasEnvironmentOnlyStaging
          ? "Staging environment exists but no staging application target is attached yet."
          : "No staging environment detected – cannot plan sync."
      ],
      warnings: [
        hasEnvironmentOnlyStaging
          ? "Provision or attach a staging application in Coolify before running sync or promote paths."
          : "Enable staging first in Settings."
      ]
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
