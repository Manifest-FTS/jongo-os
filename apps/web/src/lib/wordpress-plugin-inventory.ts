/**
 * Collecting and caching the plugin inventory for a WordPress app.
 *
 * Split from wordpress-plugin-probe.ts so the probe's parsing and shell building
 * stay unit-testable, and this file holds only the parts that need an SSH host
 * and a database.
 *
 * Cached rather than read on demand: a probe is an SSH round trip plus a
 * container exec, and 51 apps × every page render is both slow and a lot of new
 * surface pointed at the production host. The cache is refreshed in the
 * background by the hourly reconciler, stalest first, and on demand when someone
 * presses Refresh.
 */

import {
  buildPluginProbeScript,
  describeUpdateDataFreshness,
  parsePluginProbeOutput,
  readProbeTransport,
  toPluginInventory,
  type ProbedPlugin
} from "./wordpress-plugin-probe";
import { isSshHostConfigured, runHostScript } from "./ssh-exec";

export const PLUGIN_INVENTORY_SOURCE = "container_probe";

/** Refreshed in the background once older than this. */
export const PLUGIN_INVENTORY_REFRESH_AFTER_MINUTES = 60;

export type PluginInventoryStatus =
  | "ok"
  | "deferred_deploy_in_progress"
  | "no_containers"
  | "no_wordpress_container"
  | "ssh_unavailable"
  | "probe_failed";

export type CollectedPluginInventory = {
  status: PluginInventoryStatus;
  error: string | null;
  wpVersion: string | null;
  updateDataCheckedAt: Date | null;
  plugins: ProbedPlugin[];
};

/**
 * Run the probe for one Coolify resource. Never throws: an app that cannot be
 * read is a status to record, not an exception for the caller to handle.
 */
export async function collectPluginInventory(resourceUuid: string): Promise<CollectedPluginInventory> {
  const empty = { wpVersion: null, updateDataCheckedAt: null, plugins: [] as ProbedPlugin[] };

  if (!resourceUuid.trim()) {
    return { status: "no_containers", error: "This app is not linked to a Coolify resource.", ...empty };
  }
  if (!isSshHostConfigured()) {
    return { status: "ssh_unavailable", error: "SSH host is not configured, so plugin inventory cannot be read.", ...empty };
  }

  const run = await runHostScript(buildPluginProbeScript(resourceUuid), { timeoutMs: 45_000 });
  if (run.transportError) {
    return { status: "ssh_unavailable", error: run.transportError, ...empty };
  }

  const transport = readProbeTransport(run.stdout);
  switch (transport.kind) {
    case "deferred":
      // A deploy is building on the host. The next pass picks it up; recording
      // this as a failure would make a busy host look like a broken one.
      return { status: "deferred_deploy_in_progress", error: null, ...empty };
    case "no_containers":
      return { status: "no_containers", error: "No running containers were found for this app.", ...empty };
    case "no_wordpress_container":
      return { status: "no_wordpress_container", error: "No WordPress container was found for this app.", ...empty };
    case "unusable":
      return {
        status: "probe_failed",
        error: `${transport.detail}${run.stderr.trim() ? `: ${run.stderr.trim().slice(0, 300)}` : ""}`,
        ...empty
      };
    case "json":
      break;
  }

  const parsed = parsePluginProbeOutput(transport.raw);
  if (!parsed.ok) {
    return { status: "probe_failed", error: parsed.error, ...empty };
  }

  return {
    status: "ok",
    error: null,
    wpVersion: parsed.wpVersion,
    updateDataCheckedAt: parsed.updateDataCheckedAt ? new Date(parsed.updateDataCheckedAt * 1000) : null,
    plugins: parsed.plugins
  };
}

/** Probe one site and store the result. Returns what was stored. */
export async function refreshPluginInventory(input: {
  siteDbId: string;
  resourceUuid: string;
}): Promise<CollectedPluginInventory> {
  const collected = await collectPluginInventory(input.resourceUuid);

  // A deferral carries no plugin data, so writing it would replace a good
  // inventory with an empty one. The timestamp is still bumped so the sweep does
  // not spin on the same site while a deploy runs.
  const { getDb } = await import("@/lib/db");
  const db = await getDb();
  if (!db || !("wordPressPluginInventory" in db)) {
    return collected;
  }

  try {
    if (collected.status === "deferred_deploy_in_progress") {
      await (db as any).wordPressPluginInventory.updateMany({
        where: { siteId: input.siteDbId },
        data: { collectedAt: new Date() }
      });
      return collected;
    }

    await (db as any).wordPressPluginInventory.upsert({
      where: { siteId: input.siteDbId },
      create: {
        siteId: input.siteDbId,
        collectedAt: new Date(),
        source: PLUGIN_INVENTORY_SOURCE,
        status: collected.status,
        error: collected.error,
        wpVersion: collected.wpVersion,
        updateDataCheckedAt: collected.updateDataCheckedAt,
        plugins: collected.plugins as unknown as object
      },
      update: {
        collectedAt: new Date(),
        source: PLUGIN_INVENTORY_SOURCE,
        status: collected.status,
        error: collected.error,
        wpVersion: collected.wpVersion,
        updateDataCheckedAt: collected.updateDataCheckedAt,
        plugins: collected.plugins as unknown as object
      }
    });
  } catch (error) {
    console.error(`[jongo] refreshPluginInventory: could not store inventory for ${input.siteDbId}`, error);
  }

  return collected;
}

export type CachedPluginInventory = {
  collectedAt: Date;
  status: string;
  error: string | null;
  wpVersion: string | null;
  updateDataCheckedAt: Date | null;
  plugins: ProbedPlugin[];
};

export async function readCachedPluginInventory(siteDbId: string): Promise<CachedPluginInventory | null> {
  const { getDb } = await import("@/lib/db");
  const db = await getDb();
  if (!db || !("wordPressPluginInventory" in db)) return null;

  try {
    const row = await (db as any).wordPressPluginInventory.findUnique({
      where: { siteId: siteDbId },
      select: {
        collectedAt: true,
        status: true,
        error: true,
        wpVersion: true,
        updateDataCheckedAt: true,
        plugins: true
      }
    });
    if (!row) return null;

    return {
      collectedAt: row.collectedAt,
      status: row.status,
      error: row.error ?? null,
      wpVersion: row.wpVersion ?? null,
      updateDataCheckedAt: row.updateDataCheckedAt ?? null,
      plugins: Array.isArray(row.plugins) ? (row.plugins as ProbedPlugin[]) : []
    };
  } catch {
    // The table may not exist yet in an environment that has not migrated.
    return null;
  }
}

/**
 * Turn a cached inventory into the payload shape the telemetry collector already
 * merges, so the Plugins page renders it with no changes to the table.
 */
export function toPluginCollectorPayload(cached: CachedPluginInventory, now: Date = new Date()) {
  const inventory = toPluginInventory(cached.plugins);
  const freshness = describeUpdateDataFreshness(
    cached.updateDataCheckedAt ? Math.floor(cached.updateDataCheckedAt.getTime() / 1000) : null,
    now
  );
  const readable = cached.status === "ok";

  return {
    checkedAt: cached.collectedAt.toISOString(),
    source: PLUGIN_INVENTORY_SOURCE,
    tone: readable ? (inventory.updatesAvailable > 0 ? ("degraded" as const) : ("healthy" as const)) : ("unknown" as const),
    label: readable ? "Plugin inventory from container" : "Plugin inventory unavailable",
    summary: readable
      ? `${inventory.rows.length} plugins installed · ${inventory.activePlugins} active · ${inventory.updatesAvailable} update${inventory.updatesAvailable === 1 ? "" : "s"} available.`
      : cached.error ?? "The plugin inventory could not be read from this app's container.",
    guidance: readable && freshness.stale ? freshness.detail : undefined,
    // pluginStatus must read "healthy" for the page to treat the inventory as
    // present; it branches on that exact value to decide whether to show the
    // "inventory unavailable" message instead of the table.
    signals: readable
      ? {
          pluginStatus: "healthy",
          ...(cached.wpVersion ? { coreVersion: cached.wpVersion } : {}),
          updateAvailability: freshness.stale
            ? "stale"
            : inventory.updatesAvailable > 0
              ? `${inventory.updatesAvailable}_available`
              : "up_to_date"
        }
      : undefined,
    pluginInsights: {
      inventoryConnected: readable,
      activePlugins: readable ? inventory.activePlugins : null,
      inactivePlugins: readable ? inventory.inactivePlugins : null,
      updatesAvailable: readable ? inventory.updatesAvailable : null,
      securityIssues: null
    },
    pluginInventory: inventory.rows
  };
}
