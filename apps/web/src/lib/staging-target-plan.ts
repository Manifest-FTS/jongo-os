/**
 * Decide which Coolify staging copy belongs to which app, for every app at
 * once. Pure: the hourly reconciler and the enable path feed it data and apply
 * the result.
 *
 * Why this exists: Jongo used to re-guess an app's staging copy from names on
 * every page load. Copies are named after the temporary-domain slug, which
 * need not resemble the production name, so the guess only worked while a
 * copy happened to be the only one in its environment. Disabling staging then
 * could not find the copy to remove it, the switch locked on "still being
 * removed", and re-enabling built a second copy, after which neither was shown.
 *
 * The answer is recorded once (Site.stagingTargetUuid) from evidence, strongest
 * first, and never from a guess that could hand one client's copy to another:
 *
 *   1. history: the newest copy Jongo itself created or attached for the app
 *      (audit log), unless a later disable removed it;
 *   2. name_match: exactly one copy whose name reduces to the app's name;
 *   3. only_app_in_project: the app is the only one in its project and there
 *      is exactly one copy there.
 *
 * A copy two apps both lay claim to is recorded for neither and reported, and
 * copies nobody claims are reported, never deleted: removing a copy can lose
 * work, so that stays a person's decision.
 */

import { isStagingSibling } from "./staging-target-match";

export type PlanSite = {
  id: string;
  name: string;
  coolifyServiceUuid: string | null;
  coolifyProjectId: string | null;
  stagingTargetUuid: string | null;
  isStagingResource?: boolean | null;
};

export type PlanCopy = { uuid: string; name: string; projectUuid: string };

export type PlanHistoryEvent = {
  siteId: string;
  at: Date | string;
  actionType: string;
  /** The staging copy the event attached or created, when it names one. */
  uuid?: string | null;
  destroyed?: boolean | string | null;
  destroyedTargetCount?: number | string | null;
};

export type StagingPinReason = "history" | "name_match" | "only_app_in_project";

export type StagingPinPlan = {
  set: Array<{ productionUuid: string; siteIds: string[]; copyUuid: string; reason: StagingPinReason }>;
  /** Recorded copies that no longer exist in Coolify. */
  clear: Array<{ productionUuid: string; siteIds: string[]; copyUuid: string }>;
  /** Copies no app owns: left alone, reported for a person to review. */
  unclaimed: PlanCopy[];
  /** Copies more than one app could claim: recorded for none. */
  contested: Array<{ copyUuid: string; productionUuids: string[] }>;
};

const ENABLE_ACTIONS = new Set(["staging_enable_provision", "staging_enable_existing"]);

function isDestroyMarker(event: PlanHistoryEvent): boolean {
  if (event.actionType === "staging_disable_destroy") return true;
  if (event.destroyed === true || event.destroyed === "true") return true;
  return Number(event.destroyedTargetCount ?? 0) > 0;
}

function timeOf(at: Date | string): number {
  const t = new Date(at).getTime();
  return Number.isFinite(t) ? t : 0;
}

type App = {
  productionUuid: string;
  projectUuid: string;
  siteIds: string[];
  names: string[];
  pin: string | null;
};

export function planStagingPins(input: {
  sites: PlanSite[];
  copies: PlanCopy[];
  history: PlanHistoryEvent[];
  /** False when the copy list may be partial: then nothing is cleared. */
  indexComplete?: boolean;
}): StagingPinPlan {
  const plan: StagingPinPlan = { set: [], clear: [], unclaimed: [], contested: [] };
  const copyByUuid = new Map(input.copies.map((copy) => [copy.uuid, copy]));

  // One entry per production resource: duplicate Site rows for the same
  // resource share one staging copy. Staging copies imported as their own
  // Site rows are not apps.
  const apps = new Map<string, App>();
  for (const site of input.sites) {
    const productionUuid = site.coolifyServiceUuid?.trim() ?? "";
    if (!productionUuid || site.isStagingResource || copyByUuid.has(productionUuid)) continue;
    const app = apps.get(productionUuid) ?? { productionUuid, projectUuid: "", siteIds: [], names: [], pin: null };
    app.siteIds.push(site.id);
    app.names.push(site.name);
    if (!app.projectUuid && site.coolifyProjectId?.trim()) app.projectUuid = site.coolifyProjectId.trim();
    if (!app.pin && site.stagingTargetUuid?.trim()) app.pin = site.stagingTargetUuid.trim();
    apps.set(productionUuid, app);
  }

  const claimed = new Set<string>();
  const unpinned: App[] = [];
  for (const app of apps.values()) {
    if (app.pin && copyByUuid.has(app.pin)) {
      claimed.add(app.pin);
      continue;
    }
    if (app.pin) {
      // Recorded copy is gone. Only trust that on a complete inventory.
      if (input.indexComplete === false) continue;
      plan.clear.push({ productionUuid: app.productionUuid, siteIds: app.siteIds, copyUuid: app.pin });
    }
    unpinned.push(app);
  }

  const appBySite = new Map<string, App>();
  for (const app of apps.values()) for (const id of app.siteIds) appBySite.set(id, app);
  const historyByApp = new Map<string, PlanHistoryEvent[]>();
  for (const event of input.history) {
    const app = appBySite.get(event.siteId);
    if (!app) continue;
    const list = historyByApp.get(app.productionUuid) ?? [];
    list.push(event);
    historyByApp.set(app.productionUuid, list);
  }

  const appsPerProject = new Map<string, number>();
  for (const app of apps.values()) {
    if (app.projectUuid) appsPerProject.set(app.projectUuid, (appsPerProject.get(app.projectUuid) ?? 0) + 1);
  }

  const fromHistory = (app: App, available: PlanCopy[]): PlanCopy | null => {
    const events = [...(historyByApp.get(app.productionUuid) ?? [])].sort((a, b) => timeOf(a.at) - timeOf(b.at));
    let lastDestroy = -1;
    events.forEach((event, i) => {
      if (isDestroyMarker(event)) lastDestroy = i;
    });
    for (let i = events.length - 1; i > lastDestroy; i -= 1) {
      const event = events[i];
      if (!ENABLE_ACTIONS.has(event.actionType) || !event.uuid) continue;
      // Only the newest record counts. If that copy is gone, an older one is
      // not promoted in its place: it may be exactly the leftover to review.
      return available.find((copy) => copy.uuid === event.uuid) ?? null;
    }
    return null;
  };

  const byName = (app: App, available: PlanCopy[]): PlanCopy | null => {
    const matches = available.filter((copy) => app.names.some((name) => isStagingSibling(name, copy.name).match));
    return matches.length === 1 ? matches[0] : null;
  };

  const onlyApp = (app: App, available: PlanCopy[]): PlanCopy | null =>
    appsPerProject.get(app.projectUuid) === 1 && available.length === 1 ? available[0] : null;

  const proposals = new Map<string, Array<{ app: App; reason: StagingPinReason }>>();
  for (const app of unpinned) {
    if (!app.projectUuid) continue;
    const available = input.copies.filter((copy) => copy.projectUuid === app.projectUuid && !claimed.has(copy.uuid));
    if (available.length === 0) continue;

    let reason: StagingPinReason | null = null;
    let pick = fromHistory(app, available);
    if (pick) reason = "history";
    if (!pick && (pick = byName(app, available))) reason = "name_match";
    if (!pick && (pick = onlyApp(app, available))) reason = "only_app_in_project";
    if (!pick || !reason) continue;

    const list = proposals.get(pick.uuid) ?? [];
    list.push({ app, reason });
    proposals.set(pick.uuid, list);
  }

  for (const [copyUuid, list] of proposals) {
    if (list.length > 1) {
      plan.contested.push({ copyUuid, productionUuids: list.map((entry) => entry.app.productionUuid) });
      continue;
    }
    const { app, reason } = list[0];
    plan.set.push({ productionUuid: app.productionUuid, siteIds: app.siteIds, copyUuid, reason });
    claimed.add(copyUuid);
  }

  plan.unclaimed = input.copies.filter((copy) => !claimed.has(copy.uuid));
  return plan;
}
