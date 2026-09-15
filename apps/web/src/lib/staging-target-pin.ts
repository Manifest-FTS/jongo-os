import { getDb } from "@/lib/db";

/**
 * Which Coolify resource is an app's staging copy, as Jongo recorded it.
 *
 * Detection used to rest on names alone ("staging-acme" is acme's copy). Jongo
 * names copies after the temporary-domain slug, which need not resemble the
 * production name, so a copy could be invisible to the strict rule: turning
 * staging off left it running, and turning it on built a second one. With two
 * copies in the environment the display rule could no longer pick either.
 *
 * Recording the uuid Jongo itself created removes the guess. It also works the
 * other way: a copy recorded for one app is never a candidate for another, so
 * a sibling in the same project cannot adopt it through the "only resource in
 * the environment" rule once the other copies are gone.
 *
 * Both helpers are best-effort: a missing column or an unreachable database
 * means "not recorded", and detection falls back to name matching as before.
 */

export type StagingTargetPins = {
  /** The copy recorded for this app, if any. */
  own: string | null;
  /** Copies recorded for other apps: never this app's staging, whatever their names. */
  others: string[];
};

export async function readStagingTargetPins(productionUuid: string): Promise<StagingTargetPins> {
  const none: StagingTargetPins = { own: null, others: [] };
  if (!productionUuid) return none;
  try {
    const db = await getDb();
    if (!db) return none;
    const rows: Array<{ coolifyServiceUuid: string | null; stagingTargetUuid: string | null }> = await db.site.findMany({
      where: { deletedAt: null, stagingTargetUuid: { not: null } },
      orderBy: { updatedAt: "desc" },
      select: { coolifyServiceUuid: true, stagingTargetUuid: true }
    });
    const own = rows.find((row) => row.coolifyServiceUuid === productionUuid)?.stagingTargetUuid ?? null;
    const others = rows
      .filter((row) => row.coolifyServiceUuid !== productionUuid && row.stagingTargetUuid && row.stagingTargetUuid !== own)
      .map((row) => row.stagingTargetUuid as string);
    return { own, others };
  } catch {
    return none;
  }
}

export async function writeStagingTargetPin(siteId: string, stagingUuid: string | null): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.site.update({ where: { id: siteId }, data: { stagingTargetUuid: stagingUuid }, select: { id: true } });
  } catch (error) {
    console.warn(
      "[staging] could not record the staging copy for site",
      siteId,
      error instanceof Error ? error.message : error
    );
  }
}
