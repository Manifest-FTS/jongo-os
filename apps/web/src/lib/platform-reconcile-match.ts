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
  /** Coolify numeric environment id; the API exposes this but not the name. */
  environmentId?: number;
  /** Resolved from the project's environment list during index build. */
  environmentName?: string;
};

/**
 * Matches Coolify staging-ish environment names. Deliberately loose because
 * real projects use both `staging` and `stage`.
 */
export function isStagingEnvironmentName(name: unknown): boolean {
  const normalized = String(name ?? "").trim().toLowerCase();
  return normalized.includes("stag") || normalized.includes("preview");
}

export type LiveResourceIndex = {
  byUuid: Set<string>;
  all: LiveResource[];
  /** Direct lookup for per-site checks (staging detection). */
  byUuidResource?: Map<string, LiveResource>;
  /**
   * False when any resource list failed to load. Absence from an incomplete
   * index is NOT evidence that a resource was deleted.
   */
  complete?: boolean;
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
  /** Resolved staging-ness of the site's resource; undefined = undetermined. */
  isStagingResource?: boolean;
  /** True when the site's resource could not be found at all. */
  resourceMissing?: boolean;
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

/**
 * Lifecycle sync: a Site whose Coolify resource is gone should stop appearing
 * in jongo. This is deliberately conservative, because the failure mode is
 * destroying customer records (backup catalogue, collaborators, telemetry) over
 * a transient API hiccup.
 *
 * Three guards:
 *   1. Only act on a COMPLETE resource index (see LiveResourceIndex.complete).
 *   2. Require the resource to have been missing continuously for graceDays.
 *   3. Archive is a SOFT delete, so it is reversible.
 * A batch-level circuit breaker (see shouldAbortArchiveBatch) is the fourth.
 */
export type ArchiveDecision = { archive: boolean; reason: string };

export function decideSiteArchive(input: {
  missingSince: Date | null;
  now?: Date;
  graceDays?: number;
  indexComplete?: boolean;
}): ArchiveDecision {
  const graceDays = input.graceDays ?? 7;
  const now = input.now ?? new Date();

  if (input.indexComplete === false) {
    return { archive: false, reason: "index_incomplete" };
  }
  if (!input.missingSince) {
    return { archive: false, reason: "not_missing" };
  }
  const ageMs = now.getTime() - input.missingSince.getTime();
  const graceMs = graceDays * 24 * 60 * 60 * 1000;
  if (ageMs < graceMs) {
    return { archive: false, reason: "within_grace_period" };
  }
  return { archive: true, reason: "missing_beyond_grace" };
}

/**
 * Circuit breaker: if a large share of sites suddenly look deleted, that is far
 * more likely a Coolify/API problem than a real mass deletion. Refuse the whole
 * batch rather than cascade.
 */
export function shouldAbortArchiveBatch(input: {
  candidates: number;
  totalSites: number;
  maxFraction?: number;
  minTotal?: number;
}): { abort: boolean; reason: string } {
  const maxFraction = input.maxFraction ?? 0.25;
  const minTotal = input.minTotal ?? 4;
  if (input.totalSites < minTotal) {
    return { abort: false, reason: "too_few_sites_to_judge" };
  }
  if (input.candidates / input.totalSites > maxFraction) {
    return { abort: true, reason: "too_many_candidates_suspect_api_failure" };
  }
  return { abort: false, reason: "within_safe_bounds" };
}

/**
 * Scheduled backups.
 *
 * Load control is the safety-critical part here: backing up many WordPress
 * sites at once would exhaust the host (a concurrent backup already OOM-killed
 * a deploy on this server). So the reconciler backs up at most a small number
 * of sites per hourly pass, most-overdue first, which spreads a daily schedule
 * naturally across the day.
 */
export type ScheduleCandidate = {
  id: string;
  slug: string;
  backupScheduleEnabled: boolean | null;
  backupFrequencyHours: number | null;
  lastScheduledBackupAt: Date | null;
};

export function isBackupDue(
  site: ScheduleCandidate,
  opts: { now?: Date; platformDefaultEnabled?: boolean }
): boolean {
  const enabled = site.backupScheduleEnabled ?? opts.platformDefaultEnabled ?? false;
  if (!enabled) return false;
  if (!site.lastScheduledBackupAt) return true; // never run -> due
  const hours = site.backupFrequencyHours && site.backupFrequencyHours > 0 ? site.backupFrequencyHours : 24;
  const now = opts.now ?? new Date();
  return now.getTime() - site.lastScheduledBackupAt.getTime() >= hours * 60 * 60 * 1000;
}

/**
 * Pick which sites to back up this pass: only those due, most-overdue first,
 * capped so one pass cannot fan out across the whole platform.
 */
export function selectDueBackups(
  sites: ScheduleCandidate[],
  opts: { now?: Date; platformDefaultEnabled?: boolean; maxPerRun?: number }
): ScheduleCandidate[] {
  const now = opts.now ?? new Date();
  const maxPerRun = opts.maxPerRun ?? 1;
  return sites
    .filter((s) => isBackupDue(s, { now, platformDefaultEnabled: opts.platformDefaultEnabled }))
    .sort((a, b) => {
      const at = a.lastScheduledBackupAt?.getTime() ?? 0; // never-run sorts first
      const bt = b.lastScheduledBackupAt?.getTime() ?? 0;
      return at - bt;
    })
    .slice(0, Math.max(0, maxPerRun));
}
