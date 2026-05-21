import { NextResponse } from "next/server";

type CollectorRequest = {
  siteId?: string;
  slug?: string;
};

type CollectorSnapshotPayload = {
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
  pluginInventory?: CollectorMockRecord["pluginInventory"];
};

type CollectorMockRecord = {
  activePlugins?: number | null;
  inactivePlugins?: number | null;
  updatesAvailable?: number | null;
  securityIssues?: number | null;
  coreVersion?: string;
  pluginStatus?: string;
  themeStatus?: string;
  updateAvailability?: string;
  maintenanceMode?: string;
  siteHealth?: string;
  siteUrl?: string;
  pluginInventory?: Array<{
    name?: string;
    status?: string;
    version?: string | null;
    updateStatus?: string;
    securityIssues?: string | null;
  }>;
};

function parseMockMap(): Record<string, CollectorMockRecord> {
  const raw = process.env.WORDPRESS_TELEMETRY_COLLECTOR_MOCK_DATA?.trim();
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed as Record<string, CollectorMockRecord>;
  } catch {
    return {};
  }
}

function readFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizePluginInventory(
  rows: CollectorMockRecord["pluginInventory"]
): Array<{
  name: string;
  status: string;
  version: string | null;
  updateStatus: string;
  securityIssues: string | null;
}> {
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

function normalizeCollectorSnapshot(value: unknown): CollectorSnapshotPayload | null {
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

function buildSnapshot(record?: CollectorMockRecord) {
  const activePlugins = readFinite(record?.activePlugins);
  const inactivePlugins = readFinite(record?.inactivePlugins);
  const updatesAvailable = readFinite(record?.updatesAvailable);
  const securityIssues = readFinite(record?.securityIssues);
  const inventoryConnected =
    activePlugins !== null || inactivePlugins !== null || updatesAvailable !== null || securityIssues !== null;
  const pluginInventory = normalizePluginInventory(record?.pluginInventory);

  return {
    checkedAt: new Date().toISOString(),
    source: "collector_bridge_mock",
    collectorStatus: "ready_for_pull" as const,
    tone: inventoryConnected ? "healthy" : "unknown",
    label: inventoryConnected ? "Live" : "Awaiting inventory",
    summary: inventoryConnected
      ? "Live WordPress plugin inventory is connected."
      : "Collector bridge is active but no plugin inventory payload is available for this site yet.",
    guidance: inventoryConnected
      ? "Review plugin and update metrics below."
      : "Add this site to WORDPRESS_TELEMETRY_COLLECTOR_MOCK_DATA to test live inventory rendering.",
    siteUrl: record?.siteUrl?.trim() || null,
    needsSetup: !inventoryConnected,
    setupSteps: inventoryConnected
      ? []
      : [
          "Set WORDPRESS_TELEMETRY_COLLECTOR_MOCK_DATA with this site id or slug.",
          "Include plugin metric counts for active, inactive, updates, and security issues.",
          "Refresh Plugins and Integrations pages to verify live collector flow."
        ],
    signals: {
      coreVersion: record?.coreVersion ?? "collector_pending",
      pluginStatus: record?.pluginStatus ?? (inventoryConnected ? "healthy" : "collector_pending"),
      themeStatus: record?.themeStatus ?? "collector_pending",
      updateAvailability: record?.updateAvailability ?? (updatesAvailable !== null ? `${updatesAvailable} updates available` : "collector_pending"),
      maintenanceMode: record?.maintenanceMode ?? "collector_pending",
      siteHealth: record?.siteHealth ?? (inventoryConnected ? "good" : "collector_pending")
    },
    pluginInsights: {
      inventoryConnected,
      activePlugins,
      inactivePlugins,
      updatesAvailable,
      securityIssues
    },
    pluginInventory
  };
}

export async function POST(request: Request) {
  const enabled = process.env.WORDPRESS_TELEMETRY_COLLECTOR_BRIDGE_ENABLED === "true";
  if (!enabled) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const expectedToken = process.env.WORDPRESS_TELEMETRY_COLLECTOR_TOKEN?.trim();
  if (!expectedToken) {
    return NextResponse.json(
      { error: "Collector bridge is enabled but WORDPRESS_TELEMETRY_COLLECTOR_TOKEN is missing." },
      { status: 503 }
    );
  }

  const auth = request.headers.get("authorization") ?? "";
  const actualToken = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (actualToken !== expectedToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: CollectorRequest;
  try {
    body = (await request.json()) as CollectorRequest;
  } catch {
    body = {};
  }

  const siteKey = body.siteId?.trim() || body.slug?.trim() || "";
  const map = parseMockMap();
  const record = siteKey ? map[siteKey] : undefined;

  if (!record) {
    const upstreamUrl = process.env.WORDPRESS_TELEMETRY_COLLECTOR_UPSTREAM_URL?.trim();
    if (upstreamUrl) {
      const timeoutMs = Number.parseInt(process.env.WORDPRESS_TELEMETRY_COLLECTOR_UPSTREAM_TIMEOUT_MS ?? "5000", 10);
      const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeout);

      try {
        const upstreamToken = process.env.WORDPRESS_TELEMETRY_COLLECTOR_UPSTREAM_TOKEN?.trim();
        const response = await fetch(upstreamUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(upstreamToken ? { authorization: `Bearer ${upstreamToken}` } : {})
          },
          body: JSON.stringify({ siteId: body.siteId, slug: body.slug }),
          cache: "no-store",
          signal: abort.signal
        });

        if (response.ok) {
          const normalized = normalizeCollectorSnapshot(await response.json());
          if (normalized) {
            return NextResponse.json(normalized);
          }
        }
      } catch {
        // Fall through to bridge fallback payload when upstream is unavailable.
      } finally {
        clearTimeout(timer);
      }
    }
  }

  return NextResponse.json(buildSnapshot(record));
}