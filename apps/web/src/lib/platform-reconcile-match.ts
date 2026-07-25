/**
 * Pure matching logic for platform self-healing.
 *
 * Kept free of imports so it can be unit tested without pulling in the Coolify
 * client. The matcher is the risky part of mapping repair — a wrong match would
 * point backup/restore at another app's data — so it is tested directly.
 */

export type LiveResource = {
  uuid: string;
  kind: "service" | "application" | "database";
  name: string;
  projectId: string;
};

export type LiveResourceIndex = {
  byUuid: Set<string>;
  all: LiveResource[];
};

export type SiteForReconcile = {
  id: string;
  name: string;
  coolifyServiceUuid: string | null;
  coolifyProjectId: string | null;
  stagingEnabled: boolean;
};

export type SiteReconcileOutcome = {
  mappingRepaired?: { from: string; to: string; kind: string };
  mappingStale?: boolean;
  stagingEnvironmentEnsured?: boolean;
  notes: string[];
};

function normalizeName(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Propose the live resource a stale Site should point at. Exact name match, and
 * only when unambiguous — ambiguity is always left for a human.
 */
export function findRepairTarget(index: LiveResourceIndex, site: SiteForReconcile): LiveResource | null {
  let candidates = index.all.filter((r) => normalizeName(r.name) === normalizeName(site.name));
  if (candidates.length > 1 && site.coolifyProjectId) {
    const inProject = candidates.filter((r) => r.projectId === site.coolifyProjectId);
    if (inProject.length > 0) candidates = inProject;
  }
  return candidates.length === 1 ? candidates[0] : null;
}
