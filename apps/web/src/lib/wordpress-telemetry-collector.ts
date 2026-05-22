import type { SiteWorkspaceRecord } from "@/lib/repositories";
import type { WordPressTelemetrySnapshot } from "@/lib/wordpress-telemetry";
import { collectFromRestCredentials } from "@/lib/wordpress-telemetry-bridge-providers";
import { getDb } from "@/lib/db";
import { decryptSecret } from "@/lib/wordpress-telemetry-secrets";

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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

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
  requestedSiteId?: string;
}): Promise<WordPressTelemetrySnapshot | null> {
  const db = await getDb();
  let directStoredSnapshot: CollectorPayload | null = null;

  if (db) {
    const identifiers = [
      input.requestedSiteId,
      input.workspace.id,
      input.workspace.slug,
      input.fallback.siteId,
      input.workspace.coolifyServiceUuid
    ]
      .map((value) => value?.trim() || "")
      .filter((value, index, arr): value is string => Boolean(value && arr.indexOf(value) === index));

    let site:
      | {
          wordpressTelemetryConfig: {
            siteUrl: string;
            username: string;
            passwordCiphertext: string;
          } | null;
        }
      | null = null;

    const identityCandidates = identifiers.flatMap((value) => [
      ...(isUuid(value) ? [{ id: value }] : []),
      { slug: value },
      { coolifyServiceUuid: value },
      { coolifyServiceId: value }
    ]);

    for (const candidate of identityCandidates) {
      try {
        const match = await db.site.findFirst({
          where: {
            ...candidate,
            deletedAt: null
          },
          select: {
            wordpressTelemetryConfig: {
              select: {
                siteUrl: true,
                username: true,
                passwordCiphertext: true
              }
            }
          }
        });

        if (match?.wordpressTelemetryConfig) {
          site = match;
          break;
        }
      } catch {
        // Continue trying the next identity candidate.
      }
    }

    const config = site?.wordpressTelemetryConfig;
    if (config) {
      try {
        const appPassword = decryptSecret(config.passwordCiphertext);
        directStoredSnapshot = await collectFromRestCredentials(
          {
            siteUrl: config.siteUrl,
            username: config.username,
            appPassword
          },
          "collector_rest_saved"
        );
      } catch {
        directStoredSnapshot = null;
      }
    }
  }

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