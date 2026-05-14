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

function stringValue(obj: Record<string, unknown>, keys: string[], fallback = ""): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return fallback;
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
        name: "Main Marketing Site",
        status: "healthy",
        productionStatus: "healthy",
        stagingStatus: "degraded"
      },
      {
        id: "site-client-portal",
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

export async function getCoolifyOverview(): Promise<CoolifyOverview> {
  try {
    const [servicesPayload, deploymentsPayload] = await Promise.all([
      coolifyFetch("/api/v1/services"),
      coolifyFetch("/api/v1/deployments")
    ]);

    const services = ensureArray(servicesPayload);
    const deploymentsRaw = ensureArray(deploymentsPayload);

    const sites = services.map((service, index): SiteOverview => {
      const name = stringValue(service, ["name", "service_name"], `service-${index + 1}`);
      const id = stringValue(service, ["uuid", "id"], `svc-${index + 1}`);
      const productionStatus = statusFromRaw(service.status ?? service.current_status ?? service.state);
      const stagingStatus = statusFromRaw(service.staging_status ?? service.preview_status);
      const mergedStatus = productionStatus === "error" || stagingStatus === "error"
        ? "error"
        : productionStatus === "degraded" || stagingStatus === "degraded"
          ? "degraded"
          : productionStatus;

      return {
        id,
        name,
        status: mergedStatus,
        productionStatus,
        stagingStatus
      };
    });

    const deployments = deploymentsRaw.slice(0, 8).map((deployment, index): DeploymentRecord => {
      const id = stringValue(deployment, ["uuid", "id"], `dep-${index + 1}`);
      const siteName = stringValue(deployment, ["service_name", "name"], "Unknown Service");
      const environmentRaw = stringValue(deployment, ["environment", "branch", "target"], "").toLowerCase();
      const environment: DeploymentRecord["environment"] = environmentRaw.includes("stag")
        ? "staging"
        : environmentRaw.includes("prod") || environmentRaw.includes("main")
          ? "production"
          : "unknown";

      return {
        id,
        siteName,
        environment,
        status: statusFromRaw(deployment.status ?? deployment.result),
        finishedAt: stringValue(deployment, ["finished_at", "updated_at", "created_at"], "") || undefined
      };
    });

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
  } catch {
    return mockOverview();
  }
}
