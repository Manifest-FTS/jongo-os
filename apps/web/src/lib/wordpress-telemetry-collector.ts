import type { SiteWorkspaceRecord } from "@/lib/repositories";
import type { WordPressTelemetrySnapshot } from "@/lib/wordpress-telemetry";
import { collectFromStoredRestConfig } from "@/lib/wordpress-telemetry-bridge-providers";

type CollectorPayload = {
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
  signals?: Partial<WordPressTelemetrySnapshot["policy"]["signals"]>;
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

type CollectorRequestPayload = {
  siteId: string;
  slug?: string;
  workspaceId: string;
  workspaceName: string;
  siteType: SiteWorkspaceRecord["siteType"];
  coolifyServiceUuid?: string;
};

function toFiniteOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function parseCollectorPayload(value: unknown): CollectorPayload | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as CollectorPayload;
}

function normalizePluginInventory(value: CollectorPayload["pluginInventory"]): WordPressTelemetrySnapshot["policy"]["pluginInventory"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((row) => Boolean(row && typeof row === "object" && row.name?.trim()))
    .map((row) => ({
      name: row.name!.trim(),
      status: row.status?.trim() || "Unknown",
      version: row.version === null ? null : row.version?.trim() || null,
      updateStatus: row.updateStatus?.trim() || "Unknown",
      securityIssues: row.securityIssues === null ? null : row.securityIssues?.trim() || null
    }));
}

function mergeCollectorSnapshot(
  fallback: WordPressTelemetrySnapshot,
  payload: CollectorPayload
): WordPressTelemetrySnapshot {
  const mergedSignals = {
    ...fallback.policy.signals,
    ...(payload.signals ?? {})
  };

  const fallbackInsights = fallback.policy.pluginInsights;
  const incomingInsights = payload.pluginInsights ?? {};

  const mergedInsights = {
    inventoryConnected:
      typeof incomingInsights.inventoryConnected === "boolean"
        ? incomingInsights.inventoryConnected
        : fallbackInsights.inventoryConnected,
    activePlugins:
      incomingInsights.activePlugins === null ? null : toFiniteOrNull(incomingInsights.activePlugins) ?? fallbackInsights.activePlugins,
    inactivePlugins:
      incomingInsights.inactivePlugins === null ? null : toFiniteOrNull(incomingInsights.inactivePlugins) ?? fallbackInsights.inactivePlugins,
    updatesAvailable:
      incomingInsights.updatesAvailable === null ? null : toFiniteOrNull(incomingInsights.updatesAvailable) ?? fallbackInsights.updatesAvailable,
    securityIssues:
      incomingInsights.securityIssues === null ? null : toFiniteOrNull(incomingInsights.securityIssues) ?? fallbackInsights.securityIssues
  };
  const mergedInventory = normalizePluginInventory(payload.pluginInventory);

  const source = payload.source?.trim() ? "collector" : fallback.source;

  return {
    ...fallback,
    checkedAt: payload.checkedAt ?? fallback.checkedAt,
    source,
    policy: {
      ...fallback.policy,
      collectorStatus: payload.collectorStatus ?? fallback.policy.collectorStatus,
      tone: payload.tone ?? fallback.policy.tone,
      label: payload.label ?? fallback.policy.label,
      summary: payload.summary ?? fallback.policy.summary,
      guidance: payload.guidance ?? fallback.policy.guidance,
      siteUrl: payload.siteUrl?.trim() || fallback.policy.siteUrl,
      needsSetup: payload.needsSetup ?? fallback.policy.needsSetup,
      setupSteps: Array.isArray(payload.setupSteps) ? payload.setupSteps : fallback.policy.setupSteps,
      signals: mergedSignals,
      pluginInsights: mergedInsights,
      pluginInventory: mergedInventory.length > 0 ? mergedInventory : fallback.policy.pluginInventory
    }
  };
}

export async function getWordPressTelemetrySnapshotFromCollector(input: {
  fallback: WordPressTelemetrySnapshot;
  workspace: SiteWorkspaceRecord;
}): Promise<WordPressTelemetrySnapshot | null> {
  const directStoredSnapshot = await collectFromStoredRestConfig({
    workspaceId: input.workspace.id,
    siteId: input.fallback.siteId,
    slug: input.workspace.slug
  });
  if (directStoredSnapshot) {
    return mergeCollectorSnapshot(input.fallback, directStoredSnapshot);
  }

  const endpoint = process.env.WORDPRESS_TELEMETRY_COLLECTOR_URL?.trim();
  if (!endpoint) {
    return null;
  }

  const timeoutMs = Number.parseInt(process.env.WORDPRESS_TELEMETRY_COLLECTOR_TIMEOUT_MS ?? "5000", 10);
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeout);

  const body: CollectorRequestPayload = {
    siteId: input.fallback.siteId,
    slug: input.workspace.slug,
    workspaceId: input.workspace.id,
    workspaceName: input.workspace.name,
    siteType: input.workspace.siteType,
    coolifyServiceUuid: input.workspace.coolifyServiceUuid
  };

  try {
    const token = process.env.WORDPRESS_TELEMETRY_COLLECTOR_TOKEN?.trim();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: abort.signal
    });

    if (!response.ok) {
      return null;
    }

    const parsed = parseCollectorPayload(await response.json());
    if (!parsed) {
      return null;
    }

    return mergeCollectorSnapshot(input.fallback, parsed);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}