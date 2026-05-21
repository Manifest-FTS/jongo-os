type CollectorRequest = {
  siteId?: string;
  slug?: string;
};

type PluginInventoryRow = {
  name: string;
  status: string;
  version: string | null;
  updateStatus: string;
  securityIssues: string | null;
};

export type CollectorSnapshotPayload = {
  checkedAt?: string;
  source?: string;
  collectorStatus?: "pipeline_pending" | "ready_for_pull";
  tone?: "healthy" | "degraded" | "unknown";
  label?: string;
  summary?: string;
  guidance?: string;
  siteUrl?: string | null;
  needsSetup?: boolean;
  setupSteps?: string[];
  signals?: {
    coreVersion?: string;
    pluginStatus?: string;
    themeStatus?: string;
    updateAvailability?: string;
    maintenanceMode?: string;
    siteHealth?: string;
  };
  pluginInsights?: {
    inventoryConnected?: boolean;
    activePlugins?: number | null;
    inactivePlugins?: number | null;
    updatesAvailable?: number | null;
    securityIssues?: number | null;
  };
  pluginInventory?: Array<{
    name?: string;
    status?: string;
    version?: string | null;
    updateStatus?: string;
    securityIssues?: string | null;
  }>;
};

type RestSiteConfig = {
  siteUrl?: string;
  username?: string;
  appPassword?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizePluginInventory(
  rows: CollectorSnapshotPayload["pluginInventory"]
): PluginInventoryRow[] {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows
    .filter((row) => Boolean(row && typeof row === "object" && row.name?.trim()))
    .map((row) => ({
      name: row.name!.trim(),
      status: row.status?.trim() || "Unknown",
      version: row.version === null ? null : row.version?.trim() || null,
      updateStatus: row.updateStatus?.trim() || "Unknown",
      securityIssues: row.securityIssues === null ? null : row.securityIssues?.trim() || null
    }));
}

export function normalizeCollectorSnapshot(value: unknown): CollectorSnapshotPayload | null {
  if (!isRecord(value)) {
    return null;
  }

  const payload = value as CollectorSnapshotPayload;
  const insights = isRecord(payload.pluginInsights) ? payload.pluginInsights : undefined;
  const signals = isRecord(payload.signals) ? payload.signals : undefined;

  return {
    checkedAt: typeof payload.checkedAt === "string" ? payload.checkedAt : new Date().toISOString(),
    source: typeof payload.source === "string" && payload.source.trim() ? payload.source.trim() : "collector_upstream",
    collectorStatus: payload.collectorStatus === "pipeline_pending" ? "pipeline_pending" : "ready_for_pull",
    tone: payload.tone === "healthy" || payload.tone === "degraded" ? payload.tone : "unknown",
    label: typeof payload.label === "string" ? payload.label : "Live",
    summary: typeof payload.summary === "string" ? payload.summary : "Live WordPress telemetry is connected.",
    guidance: typeof payload.guidance === "string" ? payload.guidance : "Review plugin and update metrics below.",
    siteUrl: typeof payload.siteUrl === "string" ? payload.siteUrl.trim() || null : null,
    needsSetup: typeof payload.needsSetup === "boolean" ? payload.needsSetup : false,
    setupSteps: Array.isArray(payload.setupSteps) ? payload.setupSteps.filter((step) => typeof step === "string") : [],
    signals: {
      coreVersion: typeof signals?.coreVersion === "string" ? signals.coreVersion : "collector_pending",
      pluginStatus: typeof signals?.pluginStatus === "string" ? signals.pluginStatus : "collector_pending",
      themeStatus: typeof signals?.themeStatus === "string" ? signals.themeStatus : "collector_pending",
      updateAvailability: typeof signals?.updateAvailability === "string" ? signals.updateAvailability : "collector_pending",
      maintenanceMode: typeof signals?.maintenanceMode === "string" ? signals.maintenanceMode : "collector_pending",
      siteHealth: typeof signals?.siteHealth === "string" ? signals.siteHealth : "collector_pending"
    },
    pluginInsights: {
      inventoryConnected: typeof insights?.inventoryConnected === "boolean" ? insights.inventoryConnected : false,
      activePlugins: readFinite(insights?.activePlugins),
      inactivePlugins: readFinite(insights?.inactivePlugins),
      updatesAvailable: readFinite(insights?.updatesAvailable),
      securityIssues: readFinite(insights?.securityIssues)
    },
    pluginInventory: normalizePluginInventory(payload.pluginInventory)
  };
}

function parseRestSiteMap(): Record<string, RestSiteConfig> {
  const raw = process.env.WORDPRESS_TELEMETRY_REST_SITE_MAP?.trim();
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
    return parsed as Record<string, RestSiteConfig>;
  } catch {
    return {};
  }
}

function extractCoreVersion(rootJson: unknown): string {
  if (!isRecord(rootJson)) {
    return "collector_pending";
  }

  const generator = typeof rootJson.generator === "string" ? rootJson.generator : "";
  const match = generator.match(/\?v=([0-9][0-9a-zA-Z.-]*)/);
  return match?.[1] ?? "collector_pending";
}

function parsePluginRows(value: unknown): PluginInventoryRow[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const rows: PluginInventoryRow[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }

    const pluginSlug = typeof item.plugin === "string" ? item.plugin : "";
    const name = typeof item.name === "string" && item.name.trim()
      ? item.name.trim()
      : pluginSlug.split("/").pop()?.replace(/\.php$/i, "") || "Unknown plugin";
    const statusRaw = typeof item.status === "string" ? item.status : "unknown";
    const status = statusRaw === "active" ? "Active" : statusRaw === "inactive" ? "Inactive" : "Unknown";
    const version = typeof item.version === "string" && item.version.trim() ? item.version.trim() : null;
    const updateRaw = isRecord(item.update) ? item.update : null;
    const updateStatus = updateRaw ? "Update available" : "Up-to-date";

    rows.push({
      name,
      status,
      version,
      updateStatus,
      securityIssues: null
    });
  }

  return rows;
}

async function fetchJson(url: string, headers: Record<string, string>, timeoutMs: number): Promise<unknown> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      cache: "no-store",
      signal: abort.signal
    });

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function collectFromPlatformInspection(_input: CollectorRequest): Promise<CollectorSnapshotPayload | null> {
  // Placeholder for Coolify/container-level providers (WP-CLI, filesystem metadata, env introspection).
  return null;
}

export async function collectFromRestSiteMap(input: CollectorRequest): Promise<CollectorSnapshotPayload | null> {
  const siteKey = input.siteId?.trim() || input.slug?.trim() || "";
  if (!siteKey) {
    return null;
  }

  const map = parseRestSiteMap();
  const config = map[siteKey];
  const siteUrl = config?.siteUrl?.trim();
  if (!siteUrl) {
    return null;
  }

  const username = config.username?.trim();
  const appPassword = config.appPassword?.trim();
  if (!username || !appPassword) {
    return null;
  }

  const timeoutMs = Number.parseInt(process.env.WORDPRESS_TELEMETRY_REST_TIMEOUT_MS ?? "5000", 10);
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;

  const basic = Buffer.from(`${username}:${appPassword}`).toString("base64");
  const headers = {
    authorization: `Basic ${basic}`,
    "content-type": "application/json"
  };

  const normalizedBase = siteUrl.replace(/\/+$/, "");
  const root = await fetchJson(`${normalizedBase}/wp-json`, headers, timeout);
  const pluginList = await fetchJson(`${normalizedBase}/wp-json/wp/v2/plugins?per_page=100`, headers, timeout);
  const pluginInventory = parsePluginRows(pluginList);

  if (pluginInventory.length === 0) {
    return null;
  }

  const activePlugins = pluginInventory.filter((row) => row.status === "Active").length;
  const inactivePlugins = pluginInventory.filter((row) => row.status === "Inactive").length;
  const updatesAvailable = pluginInventory.filter((row) => row.updateStatus === "Update available").length;

  return {
    checkedAt: new Date().toISOString(),
    source: "collector_rest",
    collectorStatus: "ready_for_pull",
    tone: "healthy",
    label: "Live",
    summary: "WordPress telemetry is connected via secure REST application password.",
    guidance: "Review plugin and update metrics below.",
    siteUrl: normalizedBase,
    needsSetup: false,
    setupSteps: [],
    signals: {
      coreVersion: extractCoreVersion(root),
      pluginStatus: "healthy",
      themeStatus: "collector_pending",
      updateAvailability: updatesAvailable > 0 ? `${updatesAvailable} updates available` : "up-to-date",
      maintenanceMode: "collector_pending",
      siteHealth: "good"
    },
    pluginInsights: {
      inventoryConnected: true,
      activePlugins,
      inactivePlugins,
      updatesAvailable,
      securityIssues: 0
    },
    pluginInventory
  };
}
