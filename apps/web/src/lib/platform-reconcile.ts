import { coolifyFetch, ensureCoolifyStagingEnvironment } from "@/lib/coolify";

/**
 * Self-healing reconciliation for every app, run on a schedule.
 *
 * Apps are created and changed continuously, so platform invariants cannot be
 * fixed by one-off scripts. These helpers are called from the hourly reconcile
 * loop so that any app — including ones created after this code shipped — is
 * repaired automatically:
 *
 *   1. Stale resource mapping: a Site whose coolifyServiceUuid no longer
 *      resolves to a live Coolify resource is re-pointed at the current one
 *      (exact, unambiguous name match only).
 *   2. Missing staging environment: a Site with staging enabled whose Coolify
 *      project has no staging-like environment gets one created.
 */

export type {
  LiveResource,
  LiveResourceIndex,
  SiteForReconcile,
  SiteReconcileOutcome
} from "./platform-reconcile-match";
export { findRepairTarget } from "./platform-reconcile-match";

import type { LiveResource, LiveResourceIndex, SiteForReconcile, SiteReconcileOutcome } from "./platform-reconcile-match";
import { findRepairTarget } from "./platform-reconcile-match";

function projectIdOf(resource: Record<string, unknown>): string {
  const environment = resource.environment as Record<string, unknown> | undefined;
  const project = environment?.project as Record<string, unknown> | undefined;
  return String(resource.project_uuid ?? resource.project_id ?? project?.uuid ?? "");
}

/**
 * Fetch every live Coolify resource once per reconcile run, so per-site healing
 * costs no extra API calls.
 */
export async function buildLiveResourceIndex(): Promise<LiveResourceIndex> {
  const kinds: Array<{ kind: LiveResource["kind"]; path: string }> = [
    { kind: "service", path: "/api/v1/services" },
    { kind: "application", path: "/api/v1/applications" },
    { kind: "database", path: "/api/v1/databases" }
  ];

  const all: LiveResource[] = [];
  for (const { kind, path } of kinds) {
    try {
      const payload = await coolifyFetch(path);
      if (!Array.isArray(payload)) continue;
      for (const raw of payload) {
        if (!raw || typeof raw !== "object") continue;
        const resource = raw as Record<string, unknown>;
        const uuid = String(resource.uuid ?? resource.id ?? "");
        if (!uuid) continue;
        all.push({
          uuid,
          kind,
          name: String(resource.name ?? resource.human_name ?? uuid),
          projectId: projectIdOf(resource)
        });
      }
    } catch {
      // A failed kind should not abort the whole run; healing is best-effort.
    }
  }

  return { byUuid: new Set(all.map((r) => r.uuid)), all };
}

/**
 * Reconcile a single site. Returns what was (or could not be) healed.
 * `applyMappingRepair` performs the DB write; injected so the caller owns
 * persistence and this stays testable.
 */
export async function reconcileSite(
  site: SiteForReconcile,
  index: LiveResourceIndex,
  applyMappingRepair: (siteId: string, uuid: string) => Promise<void>
): Promise<SiteReconcileOutcome> {
  const outcome: SiteReconcileOutcome = { notes: [] };
  const currentUuid = site.coolifyServiceUuid?.trim() ?? "";

  // 1. Heal a stale resource mapping.
  if (currentUuid && !index.byUuid.has(currentUuid)) {
    outcome.mappingStale = true;
    const target = findRepairTarget(index, site);
    if (target) {
      await applyMappingRepair(site.id, target.uuid);
      outcome.mappingRepaired = { from: currentUuid, to: target.uuid, kind: target.kind };
      outcome.notes.push("mapping_repaired");
    } else {
      outcome.notes.push("mapping_stale_unresolved");
    }
  }

  // 2. Ensure a staging environment exists when staging is enabled.
  if (site.stagingEnabled && site.coolifyProjectId) {
    try {
      const result = await ensureCoolifyStagingEnvironment(site.coolifyProjectId);
      outcome.stagingEnvironmentEnsured = result.ok;
      outcome.notes.push(result.ok ? `staging_env_${result.reason ?? "ready"}` : "staging_env_failed");
    } catch {
      outcome.notes.push("staging_env_error");
    }
  }

  return outcome;
}
