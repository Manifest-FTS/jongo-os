export type DeploymentRecord = {
  id: string;
  siteName: string;
  environment: "production" | "staging" | "unknown";
  status: "healthy" | "degraded" | "error" | "unknown";
  finishedAt?: string;
};

export type SiteOverview = {
  id: string;
  name: string;
  deployTargetId: string;
  status: "healthy" | "degraded" | "error" | "unknown";
  productionStatus: "healthy" | "degraded" | "error" | "unknown";
  stagingStatus: "healthy" | "degraded" | "error" | "unknown";
};

export type CoolifyOverview = {
  mode: "live" | "mock";
  generatedAt: string;
  sites: SiteOverview[];
  deployments: DeploymentRecord[];
  stats: {
    healthySites: number;
    degradedSites: number;
    errorSites: number;
  };
};

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
  }
  return fallback;
}

function combineStatuses(...statuses: SiteOverview["status"][]): SiteOverview["status"] {
  if (statuses.includes("error")) return "error";
  if (statuses.includes("degraded")) return "degraded";
  if (statuses.includes("healthy")) return "healthy";
  return "unknown";
}

function deploymentEnvironmentFromRaw(deployment: Record<string, unknown>): DeploymentRecord["environment"] {
  const environmentRaw = stringValue(deployment, ["environment", "branch", "target", "environment_name"], "").toLowerCase();

  if (environmentRaw.includes("stag") || environmentRaw.includes("preview") || environmentRaw.includes("dev")) {
    return "staging";
  }

  if (environmentRaw.includes("prod") || environmentRaw.includes("main") || environmentRaw.includes("live")) {
    return "production";
  }

  return "unknown";
}

function normalizeDeploymentRecords(input: unknown, fallbackSiteName = "Unknown Service"): DeploymentRecord[] {
  return normalizeArrayPayload(input).map((deployment, index): DeploymentRecord => {
    const id = stringValue(deployment, ["uuid", "id"], `dep-${index + 1}`);
    const siteName = stringValue(deployment, ["service_name", "name", "application_name"], fallbackSiteName);

    return {
      id,
      siteName,
      environment: deploymentEnvironmentFromRaw(deployment),
      status: statusFromRaw(deployment.status ?? deployment.result ?? deployment.current_status ?? deployment.state),
      finishedAt: stringValue(deployment, ["finished_at", "updated_at", "created_at"], "") || undefined
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
    sites: [
      {
        id: "site-main",
        deployTargetId: "site-main",
        name: "Main Marketing Site",
        status: "healthy",
        productionStatus: "healthy",
        stagingStatus: "degraded"
      },
      {
        id: "site-client-portal",
        deployTargetId: "site-client-portal",
        name: "Client Portal",
        status: "degraded",
        productionStatus: "healthy",
        stagingStatus: "degraded"
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

async function buildOverviewFromApplications(applications: Record<string, unknown>[]): Promise<CoolifyOverview> {
  const enrichedSites = await Promise.all(
    applications.slice(0, 20).map(async (application, index): Promise<{ site: SiteOverview; deployments: DeploymentRecord[] }> => {
      const id = stringValue(application, ["uuid", "id"], `app-${index + 1}`);
      const deployTargetId = id;
      const name = stringValue(application, ["name", "application_name", "service_name"], `application-${index + 1}`);
      const rawStatus = statusFromRaw(application.status ?? application.current_status ?? application.state);
      const deployments = await readApplicationDeployments(id, name, 8);
      const productionDeployment = deployments.find((deployment) => deployment.environment === "production");
      const stagingDeployment = deployments.find((deployment) => deployment.environment === "staging");
      const productionStatus = productionDeployment?.status ?? statusFromRaw(application.production_status ?? application.status ?? application.current_status ?? application.state);
      const stagingStatus = stagingDeployment?.status ?? statusFromRaw(application.staging_status ?? application.preview_status ?? application.current_status ?? application.state);

      return {
        site: {
          id,
          deployTargetId,
          name,
          status: combineStatuses(rawStatus, productionStatus, stagingStatus),
          productionStatus,
          stagingStatus
        },
        deployments
      };
    })
  );

  const sites = enrichedSites.map((item) => item.site);
  const deployments = sortDeploymentsNewestFirst(
    enrichedSites.flatMap((item) => item.deployments).slice(0, 12)
  );

  const healthySites = sites.filter((site) => site.status === "healthy").length;
  const degradedSites = sites.filter((site) => site.status === "degraded").length;
  const errorSites = sites.filter((site) => site.status === "error").length;

  return {
    mode: "live",
    generatedAt: new Date().toISOString(),
    sites,
    deployments,
    stats: {
      healthySites,
      degradedSites,
      errorSites
    }
  };
}

async function buildOverviewFromServices(services: Record<string, unknown>[]): Promise<CoolifyOverview> {
  const deploymentsPayload = await coolifyFetch("/api/v1/deployments");
  const deploymentsRaw = normalizeDeploymentRecords(deploymentsPayload);

  const sites = services.map((service, index): SiteOverview => {
    const name = stringValue(service, ["name", "service_name"], `service-${index + 1}`);
    const id = stringValue(service, ["uuid", "id"], `svc-${index + 1}`);
    const deployTargetId = stringValue(service, ["uuid", "id"], id);
    const productionStatus = statusFromRaw(service.status ?? service.current_status ?? service.state);
    const stagingStatus = statusFromRaw(service.staging_status ?? service.preview_status);
    const mergedStatus = combineStatuses(productionStatus, stagingStatus);

    return {
      id,
      deployTargetId,
      name,
      status: mergedStatus,
      productionStatus,
      stagingStatus
    };
  });

  const deployments = sortDeploymentsNewestFirst(
    deploymentsRaw.slice(0, 12)
  );

  const healthySites = sites.filter((site) => site.status === "healthy").length;
  const degradedSites = sites.filter((site) => site.status === "degraded").length;
  const errorSites = sites.filter((site) => site.status === "error").length;

  return {
    mode: "live",
    generatedAt: new Date().toISOString(),
    sites,
    deployments,
    stats: {
      healthySites,
      degradedSites,
      errorSites
    }
  };
}

export async function getCoolifyOverview(): Promise<CoolifyOverview> {
  try {
    const applicationsPayload = await coolifyFetch("/api/v1/applications");
    const applications = normalizeArrayPayload(applicationsPayload);

    if (applications.length > 0) {
      return await buildOverviewFromApplications(applications);
    }

    const servicesPayload = await coolifyFetch("/api/v1/services");
    const services = normalizeArrayPayload(servicesPayload);

    if (services.length > 0) {
      return await buildOverviewFromServices(services);
    }

    return mockOverview();
  } catch {
    return mockOverview();
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
