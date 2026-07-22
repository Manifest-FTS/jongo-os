import { getDb } from "@/lib/db";
import { decryptSecret } from "@/lib/wordpress-telemetry-secrets";

type CollectorRequest = {
  workspaceId?: string;
  siteId?: string;
  slug?: string;
};

export type WordPressRestCredentials = {
  siteUrl: string;
  username: string;
  appPassword: string;
};

type PluginInventoryRow = {
  name: string;
  status: string;
  version: string | null;
  updateStatus: string;
  securityIssues: string | null;
};

type ParsedPluginInventoryRow = PluginInventoryRow & {
  pluginSlug: string | null;
};

const pluginVersionCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base"
});

const WORDPRESS_ORG_CACHE_TTL_MS = 15 * 60 * 1000;
const wordPressOrgPluginVersionCache = new Map<string, { version: string | null; expiresAt: number }>();

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

function normalizeWordPressBaseUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    let path = (parsed.pathname || "").replace(/\/+$/, "");
    path = path.replace(/\/wp-admin(?:\/.*)?$/i, "");
    path = path.replace(/\/wp-login\.php$/i, "");
    path = path.replace(/\/wp-json(?:\/.*)?$/i, "");

    const normalizedPath = path && path !== "/" ? path : "";
    return `${parsed.origin}${normalizedPath}`;
  } catch {
    return null;
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

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

function hasPluginRestRoute(rootJson: unknown): boolean {
  if (!isRecord(rootJson)) {
    return false;
  }

  const routes = rootJson.routes;
  if (!isRecord(routes)) {
    return false;
  }

  return Object.prototype.hasOwnProperty.call(routes, "/wp/v2/plugins");
}

function hasApplicationPasswordAuth(rootJson: unknown): boolean {
  if (!isRecord(rootJson)) {
    return false;
  }

  const authentication = rootJson.authentication;
  if (!isRecord(authentication)) {
    return false;
  }

  return Object.prototype.hasOwnProperty.call(authentication, "application-passwords");
}

function extractPluginSlug(item: Record<string, unknown>, pluginPath: string): string | null {
  const directSlug = typeof item.slug === "string" ? item.slug.trim() : "";
  if (directSlug) {
    return directSlug.toLowerCase();
  }

  const candidate = pluginPath.split("/")[0]?.trim() || "";
  if (!candidate || !/^[a-z0-9][a-z0-9._-]*$/i.test(candidate)) {
    return null;
  }

  return candidate.toLowerCase();
}

function comparePluginVersions(installedVersion: string, latestVersion: string): number {
  return pluginVersionCollator.compare(installedVersion.trim(), latestVersion.trim());
}

function parsePluginRows(value: unknown): ParsedPluginInventoryRow[] {
  const listValue = Array.isArray(value)
    ? value
    : isRecord(value)
      ? value.plugins ?? value.items ?? value.data ?? value.results ?? []
      : [];

  if (!Array.isArray(listValue)) {
    return [];
  }

  const securityKeyword = /vulnerab|security|critical|xss|sql\s*injection|rce/i;

  function hasSecuritySignal(item: Record<string, unknown>, update: Record<string, unknown> | null): boolean {
    const vulnerabilities = item.vulnerabilities;
    if (Array.isArray(vulnerabilities) && vulnerabilities.length > 0) {
      return true;
    }

    const vulnerability = isRecord(item.vulnerability) ? item.vulnerability : null;
    const vulnerabilityCount = typeof vulnerability?.count === "number" ? vulnerability.count : 0;
    if (vulnerabilityCount > 0) {
      return true;
    }

    const directSignals = [
      item.securityIssue,
      item.security_issue,
      item.security,
      update?.security,
      update?.security_issue,
      update?.upgrade_notice,
      update?.notice,
      update?.message
    ];

    return directSignals.some((signal) => typeof signal === "string" && securityKeyword.test(signal));
  }

  function getUpdateStatus(item: Record<string, unknown>, update: Record<string, unknown> | null): "Update available" | "Up-to-date" | "Unknown" {
    if (typeof item.has_update === "boolean") {
      return item.has_update ? "Update available" : "Up-to-date";
    }

    if (typeof item.updateAvailable === "boolean") {
      return item.updateAvailable ? "Update available" : "Up-to-date";
    }

    if (update) {
      const response = typeof update.response === "string" ? update.response.toLowerCase() : "";
      if (response === "upgrade" || response === "update_available") {
        return "Update available";
      }
      if (response === "latest" || response === "none" || response === "up_to_date" || response === "no_update") {
        return "Up-to-date";
      }

      const packageUrl = typeof update.package === "string" ? update.package.trim() : "";
      const newVersion = typeof update.new_version === "string" ? update.new_version.trim() : "";
      if (packageUrl.length > 0 || newVersion.length > 0) {
        return "Update available";
      }

      return "Unknown";
    }

    if (typeof item.update === "string") {
      const updateValue = item.update.toLowerCase();
      if (updateValue.includes("available") || updateValue.includes("upgrade") || updateValue === "true") {
        return "Update available";
      }
      if (updateValue.includes("up-to-date") || updateValue.includes("latest") || updateValue === "false" || updateValue === "none") {
        return "Up-to-date";
      }

      return "Unknown";
    }

    return "Unknown";
  }

  const rows: ParsedPluginInventoryRow[] = [];
  for (const item of listValue) {
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
    const updateStatus = getUpdateStatus(item, updateRaw);
    const securityIssues = hasSecuritySignal(item, updateRaw) ? "Vulnerability detected" : null;

    rows.push({
      name,
      status,
      version,
      updateStatus,
      securityIssues,
      pluginSlug: extractPluginSlug(item, pluginSlug)
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

async function fetchWordPressOrgPluginVersion(slug: string, timeoutMs: number): Promise<string | null> {
  const cached = wordPressOrgPluginVersionCache.get(slug);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.version;
  }

  const params = new URLSearchParams({
    action: "plugin_information",
    "request[slug]": slug
  });

  const payload = await fetchJson(
    `https://api.wordpress.org/plugins/info/1.2/?${params.toString()}`,
    { accept: "application/json" },
    timeoutMs
  );

  const version = isRecord(payload) && typeof payload.version === "string" && payload.version.trim()
    ? payload.version.trim()
    : null;

  wordPressOrgPluginVersionCache.set(slug, {
    version,
    expiresAt: Date.now() + WORDPRESS_ORG_CACHE_TTL_MS
  });

  return version;
}

async function enrichPluginRows(rows: ParsedPluginInventoryRow[], timeoutMs: number): Promise<PluginInventoryRow[]> {
  const publicSlugs = [...new Set(rows.map((row) => row.pluginSlug).filter((slug): slug is string => Boolean(slug)))];
  const versionBySlug = new Map<string, string | null>();

  await Promise.all(
    publicSlugs.map(async (slug) => {
      versionBySlug.set(slug, await fetchWordPressOrgPluginVersion(slug, timeoutMs));
    })
  );

  return rows.map((row) => {
    let updateStatus = row.updateStatus;
    const latestVersion = row.pluginSlug ? versionBySlug.get(row.pluginSlug) ?? null : null;

    if (updateStatus === "Unknown") {
      if (latestVersion && row.version) {
        updateStatus = comparePluginVersions(row.version, latestVersion) < 0 ? "Update available" : "Up-to-date";
      } else if (row.pluginSlug) {
        updateStatus = "No public update data";
      } else {
        updateStatus = "Private/custom plugin";
      }
    }

    return {
      name: row.name,
      status: row.status,
      version: row.version,
      updateStatus,
      securityIssues: row.securityIssues ?? "No vulnerability feed"
    };
  });
}

async function fetchJsonWithStatus(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      cache: "no-store",
      signal: abort.signal
    });

    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    return {
      ok: response.ok,
      status: response.status,
      data
    };
  } catch {
    return {
      ok: false,
      status: 0,
      data: null
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function collectFromRestCredentials(
  credentials: WordPressRestCredentials,
  source: string
): Promise<CollectorSnapshotPayload | null> {
  const siteUrl = normalizeWordPressBaseUrl(credentials.siteUrl);
  const username = credentials.username.trim();
  const appPassword = credentials.appPassword.trim();

  if (!siteUrl || !username || !appPassword) {
    return null;
  }

  const timeoutMs = Number.parseInt(process.env.WORDPRESS_TELEMETRY_REST_TIMEOUT_MS ?? "5000", 10);
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;

  const basic = Buffer.from(`${username}:${appPassword}`).toString("base64");
  const headers = {
    authorization: `Basic ${basic}`,
    "content-type": "application/json"
  };

  function buildUnavailableSnapshot(params: {
    label: string;
    summary: string;
    guidance: string;
    pluginStatus: string;
    siteHealth: string;
  }): CollectorSnapshotPayload {
    return {
      checkedAt: new Date().toISOString(),
      source,
      collectorStatus: "ready_for_pull",
      tone: "degraded",
      label: params.label,
      summary: params.summary,
      guidance: params.guidance,
      siteUrl: normalizedBase,
      needsSetup: false,
      setupSteps: [],
      signals: {
        coreVersion: "collector_pending",
        pluginStatus: params.pluginStatus,
        themeStatus: "collector_pending",
        updateAvailability: "collector_pending",
        maintenanceMode: "collector_pending",
        siteHealth: params.siteHealth
      },
      pluginInsights: {
        inventoryConnected: false,
        activePlugins: null,
        inactivePlugins: null,
        updatesAvailable: null,
        securityIssues: null
      },
      pluginInventory: []
    };
  }

  const normalizedBase = siteUrl.replace(/\/+$/, "");
  const authCheck = await fetchJsonWithStatus(`${normalizedBase}/wp-json/wp/v2/users/me`, headers, timeout);
  const [root, pluginList] = await Promise.all([
    fetchJson(`${normalizedBase}/wp-json`, headers, timeout),
    fetchJsonWithStatus(`${normalizedBase}/wp-json/wp/v2/plugins?per_page=100`, headers, timeout)
  ]);
  const pluginRouteAvailable = hasPluginRestRoute(root);
  const appPasswordAuthAvailable = hasApplicationPasswordAuth(root);

  if (!pluginList.ok) {
    if (!pluginRouteAvailable || pluginList.status === 404) {
      return buildUnavailableSnapshot({
        label: "Plugin REST route unavailable",
        summary: "This WordPress site is not exposing the /wp/v2/plugins REST route required for plugin telemetry.",
        guidance: "Ensure WordPress REST API remains enabled, update WordPress core if needed, and verify no security plugin or WAF rule blocks /wp-json/wp/v2/plugins.",
        pluginStatus: "plugin_route_unavailable",
        siteHealth: "degraded"
      });
    }

    if (!authCheck.ok || !isRecord(authCheck.data)) {
      if (authCheck.status === 401 || authCheck.status === 403) {
        if (!appPasswordAuthAvailable) {
          return buildUnavailableSnapshot({
            label: "Application passwords unavailable",
            summary: "This WordPress site is not advertising application-password authentication for REST telemetry.",
            guidance: "Enable HTTPS and application-password authentication on the site, then reconnect WordPress telemetry credentials.",
            pluginStatus: "app_passwords_unavailable",
            siteHealth: "degraded"
          });
        }

        return buildUnavailableSnapshot({
          label: "Credentials rejected",
          summary: "Saved WordPress telemetry credentials were rejected by the site.",
          guidance: "Update the saved username or application password, then test the connection again.",
          pluginStatus: "credentials_rejected",
          siteHealth: "authentication_failed"
        });
      }
    }

    if (pluginList.status === 401 || pluginList.status === 403) {
      return buildUnavailableSnapshot({
        label: "Plugin access limited",
        summary: "WordPress telemetry credentials are valid, but this user cannot read installed plugins.",
        guidance: "Use an application password for a user with plugin management access, then retry telemetry.",
        pluginStatus: "limited_access",
        siteHealth: "good"
      });
    }

    if (pluginList.status >= 500) {
      return buildUnavailableSnapshot({
        label: "Plugin endpoint unavailable",
        summary: "The WordPress plugins endpoint responded with a server error while inventory was loading.",
        guidance: "Check the site's plugin administration endpoint and hosting health, then refresh telemetry.",
        pluginStatus: "plugin_endpoint_unavailable",
        siteHealth: "degraded"
      });
    }

    if (pluginList.status === 0) {
      return buildUnavailableSnapshot({
        label: "Plugin endpoint unreachable",
        summary: "Jongo could not reach the WordPress plugins endpoint for this site.",
        guidance: "Verify the saved site URL and outbound network path to the WordPress site, then retry.",
        pluginStatus: "plugin_endpoint_unreachable",
        siteHealth: "unreachable"
      });
    }

    return buildUnavailableSnapshot({
      label: "Plugin endpoint unavailable",
      summary: "WordPress accepted the saved credentials, but plugin inventory could not be loaded.",
      guidance: "Verify the site's REST plugin endpoint and retry telemetry.",
      pluginStatus: "plugin_endpoint_unavailable",
      siteHealth: "degraded"
    });
  }

  const pluginInventory = await enrichPluginRows(parsePluginRows(pluginList.data), Math.min(timeout, 2500));

  if (pluginInventory.length === 0) {
    return {
      checkedAt: new Date().toISOString(),
      source,
      collectorStatus: "ready_for_pull",
      tone: "degraded",
      label: "Connected",
      summary: "WordPress telemetry credentials are valid, but plugin inventory endpoint access is limited.",
      guidance: "Keep this connection saved. Plugin inventory will appear when REST plugin permissions are enabled for this user.",
      siteUrl: normalizedBase,
      needsSetup: false,
      setupSteps: [],
      signals: {
        coreVersion: extractCoreVersion(root),
        pluginStatus: "limited_access",
        themeStatus: "collector_pending",
        updateAvailability: "collector_pending",
        maintenanceMode: "collector_pending",
        siteHealth: "good"
      },
      pluginInsights: {
        inventoryConnected: false,
        activePlugins: null,
        inactivePlugins: null,
        updatesAvailable: null,
        securityIssues: null
      },
      pluginInventory: []
    };
  }

  const activePlugins = pluginInventory.filter((row) => row.status === "Active").length;
  const inactivePlugins = pluginInventory.filter((row) => row.status === "Inactive").length;
  const updatesAvailable = pluginInventory.filter((row) => row.updateStatus === "Update available").length;
  const updatesUnavailable = pluginInventory.filter(
    (row) => row.updateStatus === "No public update data" || row.updateStatus === "Private/custom plugin"
  ).length;
  const securityIssueCount = pluginInventory.filter((row) => row.securityIssues === "Vulnerability detected").length;
  const securityFeedUnavailable = pluginInventory.filter((row) => row.securityIssues === "No vulnerability feed").length;

  return {
    checkedAt: new Date().toISOString(),
    source,
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
      updateAvailability:
        updatesAvailable > 0
          ? `${updatesAvailable} updates available`
          : updatesUnavailable > 0
            ? "partial public update coverage"
            : "up-to-date",
      maintenanceMode: "collector_pending",
      siteHealth: "good"
    },
    pluginInsights: {
      inventoryConnected: true,
      activePlugins,
      inactivePlugins,
      updatesAvailable: updatesUnavailable > 0 ? null : updatesAvailable,
      securityIssues: securityFeedUnavailable > 0 && securityIssueCount === 0 ? null : securityIssueCount
    },
    pluginInventory
  };
}

export async function collectFromStoredRestConfig(input: CollectorRequest): Promise<CollectorSnapshotPayload | null> {
  const keys = [input.workspaceId, input.siteId, input.slug]
    .map((value) => value?.trim() || "")
    .filter((value, index, arr) => value.length > 0 && arr.indexOf(value) === index);

  if (keys.length === 0) {
    return null;
  }

  const db = await getDb();
  if (!db) {
    return null;
  }

  const identityMatches = keys.flatMap((key) =>
    isUuid(key)
      ? [{ id: key }, { slug: key }, { coolifyServiceUuid: key }, { coolifyServiceId: key }]
      : [{ slug: key }, { coolifyServiceUuid: key }, { coolifyServiceId: key }]
  );

  const identityWhere = {
    OR: identityMatches,
    deletedAt: null
  };

  const site = await db.site.findFirst({
    where: identityWhere,
    select: {
      id: true
    }
  });

  const config = site?.id
    ? await db.wordPressTelemetryConfig.findUnique({
        where: { siteId: site.id },
        select: {
          siteUrl: true,
          username: true,
          passwordCiphertext: true
        }
      })
    : null;

  if (!config) {
    return null;
  }

  let appPassword = "";
  try {
    appPassword = decryptSecret(config.passwordCiphertext);
  } catch {
    return null;
  }

  return collectFromRestCredentials(
    {
      siteUrl: config.siteUrl,
      username: config.username,
      appPassword
    },
    "collector_rest_saved"
  );
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

  return collectFromRestCredentials(
    {
      siteUrl,
      username: config.username?.trim() || "",
      appPassword: config.appPassword?.trim() || ""
    },
    "collector_rest_env_map"
  );
}
