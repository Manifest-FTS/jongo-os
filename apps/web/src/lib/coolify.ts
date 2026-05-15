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
};

export type CoolifyProjectRecord = {
  id: string;
  name: string;
};

export type CoolifyOverview = {
  mode: "live" | "mock";
  generatedAt: string;
  projects: CoolifyProjectRecord[];
  sites: SiteOverview[];
  deployments: DeploymentRecord[];
  stats: {
    healthySites: number;
    degradedSites: number;
    errorSites: number;
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

      if (!id || seen.has(id)) {
        return null;
      }

      seen.add(id);
      return { id, name };
    })
    .filter((project): project is CoolifyProjectRecord => Boolean(project));
}

function resolveProjectForResource(
  resource: Record<string, unknown>,
  projectsById: Map<string, CoolifyProjectRecord>,
  projectsByName: Map<string, CoolifyProjectRecord>
): { id?: string; name?: string } {
  const idCandidates = new Set<string>();
  const nameCandidates = new Set<string>();
  const rawNameCandidates = new Set<string>();

  const directId = stringValue(resource, ["project_uuid", "project_id", "projectId"], "");
  if (directId) idCandidates.add(directId);

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
  return {
    id: fallbackId,
    name: fallbackName
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

    if (!response.ok) {
      throw new Error(`Coolify request failed (${response.status}) for ${path}`);
    }

    return response.json();
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
      errorSites: 0
    }
  };
}

function emptyLiveOverview(): CoolifyOverview {
  return {
    mode: "live",
    generatedAt: new Date().toISOString(),
    projects: [],
    sites: [],
    deployments: [],
    stats: {
      healthySites: 0,
      degradedSites: 0,
      errorSites: 0
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
  projectsByName: Map<string, CoolifyProjectRecord>
): SiteOverview {
  const id = stringValue(resource, ["uuid", "id"], fallbackId);
  const name = stringValue(resource, ["name", "application_name", "service_name"], fallbackName);
  const productionStatus = statusFromRaw(resource.production_status ?? resource.status ?? resource.current_status ?? resource.state ?? resource.server_status);
  const stagingStatus = statusFromRaw(resource.staging_status ?? resource.preview_status);
  const project = resolveProjectForResource(resource, projectsById, projectsByName);

  return {
    id,
    deployTargetId: id,
    name,
    status: combineStatuses(productionStatus, stagingStatus),
    productionStatus,
    stagingStatus,
    siteType: detectSiteType(resource),
    coolifyProjectId: project.id,
    coolifyProjectName: project.name
  };
}

function buildSiteStats(sites: SiteOverview[]) {
  return {
    healthySites: sites.filter((site) => site.status === "healthy").length,
    degradedSites: sites.filter((site) => site.status === "degraded").length,
    errorSites: sites.filter((site) => site.status === "error").length
  };
}

async function buildLiveOverview(
  applications: Record<string, unknown>[],
  services: Record<string, unknown>[],
  databases: Record<string, unknown>[],
  projects: CoolifyProjectRecord[]
): Promise<CoolifyOverview> {
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const projectsByName = new Map(projects.map((project) => [project.name.trim().toLowerCase(), project]));

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

  const applicationSitesWithDeployments = await Promise.all(
    standaloneApplications.slice(0, 20).map(async (application, index): Promise<{ site: SiteOverview; deployments: DeploymentRecord[] }> => {
      const site = makeSiteOverview(application, `application-${index + 1}`, `app-${index + 1}`, projectsById, projectsByName);
      const deployments = await readApplicationDeployments(site.id, site.name, 8);
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
    makeSiteOverview(service, `service-${index + 1}`, `svc-${index + 1}`, projectsById, projectsByName)
  );
  const databaseSites = standaloneDatabases.map((database, index) =>
    makeSiteOverview(database, `database-${index + 1}`, `db-${index + 1}`, projectsById, projectsByName)
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
    sites,
    deployments,
    stats: buildSiteStats(sites)
  };
}

export async function getCoolifyOverview(): Promise<CoolifyOverview> {
  const baseUrl = process.env.COOLIFY_API_BASE_URL;
  const token = process.env.COOLIFY_API_TOKEN;

  if (!baseUrl || !token) {
    return mockOverview();
  }

  try {
    let projects: CoolifyProjectRecord[] = [];
    try {
      const projectsPayload = await coolifyFetch("/api/v1/projects");
      projects = normalizeProjectRecords(projectsPayload);
    } catch {
      projects = [];
    }

    const applicationsPayload = await coolifyFetch("/api/v1/applications");
    const applications = normalizeArrayPayload(applicationsPayload);

    const servicesPayload = await coolifyFetch("/api/v1/services");
    const services = normalizeArrayPayload(servicesPayload);

    const databasesPayload = await coolifyFetch("/api/v1/databases");
    const databases = normalizeArrayPayload(databasesPayload);

    if (applications.length > 0 || services.length > 0 || databases.length > 0) {
      return await buildLiveOverview(applications, services, databases, projects);
    }

    return {
      ...emptyLiveOverview(),
      projects
    };
  } catch {
    return emptyLiveOverview();
  }
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
