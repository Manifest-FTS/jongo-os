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
export { findRepairTarget, isStagingEnvironmentName } from "./platform-reconcile-match";

import type { LiveResource, LiveResourceIndex, SiteForReconcile, SiteReconcileOutcome } from "./platform-reconcile-match";
import { findRepairTarget, isStagingEnvironmentName } from "./platform-reconcile-match";

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

  // Resources expose only a numeric environment_id, so resolve id -> name from
  // the projects' environment lists (the /projects list omits environments, so
  // each project's detail is read once per run).
  const environmentNameById = new Map<number, string>();
  try {
    const projects = await coolifyFetch("/api/v1/projects");
    if (Array.isArray(projects)) {
      for (const p of projects) {
        const uuid = String((p as Record<string, unknown>)?.uuid ?? "");
        if (!uuid) continue;
        try {
          const detail = await coolifyFetch(`/api/v1/projects/${encodeURIComponent(uuid)}`);
          const envs = (detail as { environments?: unknown })?.environments;
          if (!Array.isArray(envs)) continue;
          for (const e of envs) {
            const env = e as Record<string, unknown>;
            const id = Number(env.id);
            if (Number.isFinite(id)) environmentNameById.set(id, String(env.name ?? ""));
          }
        } catch {
          // Skip a project we cannot read; staging detection degrades, not fails.
        }
      }
    }
  } catch {
    // No environment names available this run; isStagingResource stays unchanged.
  }

  const all: LiveResource[] = [];
  // If ANY resource list fails, absence from the index no longer proves a
  // resource was deleted — it may just be an API blip. Callers must not treat
  // an incomplete index as evidence of deletion.
  let complete = true;
  for (const { kind, path } of kinds) {
    try {
      const payload = await coolifyFetch(path);
      if (!Array.isArray(payload)) { complete = false; continue; }
      for (const raw of payload) {
        if (!raw || typeof raw !== "object") continue;
        const resource = raw as Record<string, unknown>;
        const uuid = String(resource.uuid ?? resource.id ?? "");
        if (!uuid) continue;
        const environmentId = Number(resource.environment_id);
        all.push({
          uuid,
          kind,
          name: String(resource.name ?? resource.human_name ?? uuid),
          projectId: projectIdOf(resource),
          environmentId: Number.isFinite(environmentId) ? environmentId : undefined,
          environmentName: Number.isFinite(environmentId)
            ? environmentNameById.get(environmentId)
            : undefined
        });
      }
    } catch {
      // A failed kind should not abort the whole run, but it does mean the
      // index is partial.
      complete = false;
    }
  }

  return {
    byUuid: new Set(all.map((r) => r.uuid)),
    all,
    byUuidResource: new Map(all.map((r) => [r.uuid, r])),
    complete
  };
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
  if (currentUuid && !index.byUuid.has(currentUuid) && index.complete !== false) {
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

  // 2. Classify the resource: is it a staging counterpart, or missing entirely?
  //    Persisted by the caller so the UI and backup eligibility read a cheap
  //    flag instead of re-deriving this per page load.
  const effectiveUuid = outcome.mappingRepaired?.to ?? currentUuid;
  const resource = effectiveUuid ? index.byUuidResource?.get(effectiveUuid) : undefined;
  if (resource) {
    outcome.resourceMissing = false;
    if (resource.environmentName !== undefined) {
      outcome.isStagingResource = isStagingEnvironmentName(resource.environmentName);
      if (outcome.isStagingResource) outcome.notes.push("staging_resource");
    }
  } else if (effectiveUuid && index.complete !== false) {
    outcome.resourceMissing = true;
    outcome.notes.push("resource_missing");
  } else if (effectiveUuid) {
    // Partial index — say nothing rather than falsely flag the resource gone.
    outcome.notes.push("resource_check_skipped_incomplete_index");
  }

  // 3. Ensure a staging environment exists when staging is enabled.
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
