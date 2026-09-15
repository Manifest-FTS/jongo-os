import { coolifyFetch } from "@/lib/coolify";
import { isStagingEnvironmentName, type LiveResourceIndex } from "./platform-reconcile-match";
import {
  planStagingPins,
  type PlanCopy,
  type PlanHistoryEvent,
  type PlanSite,
  type StagingPinPlan
} from "./staging-target-plan";

/**
 * Applies lib/staging-target-plan.ts to the platform: hourly for every app,
 * and for one app just before its staging is turned on.
 */

const HISTORY_ACTIONS = [
  "staging_enable_provision",
  "staging_enable_existing",
  "staging_disable_destroy",
  "staging_disable_requested"
];

const SITE_SELECT = {
  id: true,
  name: true,
  coolifyServiceUuid: true,
  coolifyProjectId: true,
  stagingTargetUuid: true,
  isStagingResource: true
} as const;

export async function loadStagingHistory(db: any, siteIds: string[]): Promise<PlanHistoryEvent[]> {
  if (siteIds.length === 0) return [];
  const rows: Array<{
    siteId: string;
    at: Date;
    actionType: string;
    uuid: string | null;
    destroyed: string | null;
    destroyedTargetCount: string | null;
  }> = await db.$queryRaw`
    SELECT "resourceId" AS "siteId", "createdAt" AS "at",
           details->>'actionType' AS "actionType",
           details->'capability'->>'applicationUuid' AS "uuid",
           details->>'destroyed' AS "destroyed",
           details->>'destroyedTargetCount' AS "destroyedTargetCount"
    FROM "AuditLog"
    WHERE "resourceId" = ANY(${siteIds})
      AND details->>'actionType' = ANY(${HISTORY_ACTIONS})
    ORDER BY "createdAt" ASC`;
  return rows;
}

/** Staging-environment resources from the reconciler's live index. */
export function stagingCopiesFromIndex(index: LiveResourceIndex): PlanCopy[] {
  return index.all
    .filter((resource) => resource.kind !== "database" && isStagingEnvironmentName(resource.environmentName))
    .map((resource) => ({ uuid: resource.uuid, name: resource.name, projectUuid: resource.projectUuid ?? "" }))
    .filter((copy) => copy.projectUuid.length > 0);
}

/** Staging-environment resources of one project. Throws rather than return a partial list. */
async function listProjectStagingCopies(projectUuid: string): Promise<PlanCopy[]> {
  const detail = await coolifyFetch(`/api/v1/projects/${encodeURIComponent(projectUuid)}`);
  const environments = (detail as { environments?: unknown })?.environments;
  const stagingEnvironmentIds = new Set<number>();
  if (Array.isArray(environments)) {
    for (const raw of environments) {
      const environment = raw as Record<string, unknown>;
      const id = Number(environment.id);
      if (Number.isFinite(id) && isStagingEnvironmentName(environment.name)) stagingEnvironmentIds.add(id);
    }
  }
  if (stagingEnvironmentIds.size === 0) return [];

  const copies: PlanCopy[] = [];
  for (const path of ["/api/v1/services", "/api/v1/applications"]) {
    const payload = await coolifyFetch(path);
    // A partial list could make "the only copy in the project" true by omission.
    if (!Array.isArray(payload)) throw new Error(`Coolify ${path} did not return a list`);
    for (const raw of payload) {
      const resource = raw as Record<string, unknown>;
      const uuid = String(resource.uuid ?? "");
      if (!uuid || resource.deleted_at || !stagingEnvironmentIds.has(Number(resource.environment_id))) continue;
      copies.push({ uuid, name: String(resource.name ?? uuid), projectUuid });
    }
  }
  return copies;
}

async function applyPlan(db: any, plan: Pick<StagingPinPlan, "set" | "clear">): Promise<void> {
  for (const entry of plan.clear) {
    await db.site.updateMany({
      where: { id: { in: entry.siteIds }, stagingTargetUuid: entry.copyUuid },
      data: { stagingTargetUuid: null }
    });
  }
  for (const entry of plan.set) {
    await db.site.updateMany({
      where: { id: { in: entry.siteIds }, deletedAt: null },
      data: { stagingTargetUuid: entry.copyUuid }
    });
  }
}

export type StagingTargetReconcileResult = {
  skipped?: "incomplete_index";
  recorded: Array<{ copyUuid: string; reason: string; siteIds: string[] }>;
  cleared: number;
  unclaimed: Array<{ uuid: string; name: string; projectUuid: string }>;
  contested: Array<{ copyUuid: string; productionUuids: string[] }>;
};

/** Hourly: record every app's staging copy; report leftovers. */
export async function reconcileStagingTargets(params: {
  db: any;
  index: LiveResourceIndex;
}): Promise<StagingTargetReconcileResult> {
  const empty: StagingTargetReconcileResult = { recorded: [], cleared: 0, unclaimed: [], contested: [] };
  // Absence from a partial inventory proves nothing, and "only copy in the
  // project" could be true by omission. Try again next hour.
  if (params.index.complete === false) return { ...empty, skipped: "incomplete_index" };

  const sites: PlanSite[] = await params.db.site.findMany({
    where: { deletedAt: null, NOT: [{ coolifyServiceUuid: null }] },
    select: SITE_SELECT
  });
  const history = await loadStagingHistory(params.db, sites.map((site) => site.id));
  const plan = planStagingPins({ sites, copies: stagingCopiesFromIndex(params.index), history, indexComplete: true });
  await applyPlan(params.db, plan);

  if (plan.unclaimed.length > 0) {
    console.warn(
      `[staging] ${plan.unclaimed.length} staging cop${plan.unclaimed.length === 1 ? "y" : "ies"} belong to no app:`,
      plan.unclaimed.map((copy) => `${copy.name} (${copy.uuid})`).join(", ")
    );
  }

  return {
    recorded: plan.set.map((entry) => ({ copyUuid: entry.copyUuid, reason: entry.reason, siteIds: entry.siteIds })),
    cleared: plan.clear.length,
    unclaimed: plan.unclaimed,
    contested: plan.contested
  };
}

/**
 * Before turning staging on: record this app's existing copy, if the evidence
 * says it has one, so enabling re-attaches it instead of building a duplicate.
 * Best-effort: any failure means "nothing recorded" and enabling proceeds as
 * before. Returns the recorded copy, if any.
 */
export async function claimStagingCopyForSite(db: any, siteId: string): Promise<string | null> {
  try {
    const site = await db.site.findUnique({ where: { id: siteId }, select: SITE_SELECT });
    const projectUuid = site?.coolifyProjectId?.trim();
    if (!site?.coolifyServiceUuid || !projectUuid) return null;
    if (site.stagingTargetUuid) return site.stagingTargetUuid;

    const [sites, copies]: [PlanSite[], PlanCopy[]] = await Promise.all([
      db.site.findMany({
        where: { deletedAt: null, coolifyProjectId: projectUuid, NOT: [{ coolifyServiceUuid: null }] },
        select: SITE_SELECT
      }),
      listProjectStagingCopies(projectUuid)
    ]);
    const history = await loadStagingHistory(db, sites.map((row) => row.id));
    const plan = planStagingPins({ sites, copies, history, indexComplete: true });
    const mine = plan.set.find((entry) => entry.siteIds.includes(siteId));
    if (!mine) return null;
    await applyPlan(db, { set: [mine], clear: [] });
    return mine.copyUuid;
  } catch (error) {
    console.warn("[staging] could not check for an existing staging copy:", error instanceof Error ? error.message : error);
    return null;
  }
}
