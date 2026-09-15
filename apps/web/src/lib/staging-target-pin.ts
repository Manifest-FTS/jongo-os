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
 * Recording the uuid Jongo itself created removes the guess. Both helpers are
 * best-effort: a missing column or an unreachable database means "not
 * recorded", and detection falls back to name matching exactly as before.
 */

export async function readStagingTargetPin(productionUuid: string): Promise<string | null> {
  if (!productionUuid) return null;
  try {
    const db = await getDb();
    if (!db) return null;
    const row = await db.site.findFirst({
      where: { coolifyServiceUuid: productionUuid, deletedAt: null, stagingTargetUuid: { not: null } },
      orderBy: { updatedAt: "desc" },
      select: { stagingTargetUuid: true }
    });
    return row?.stagingTargetUuid ?? null;
  } catch {
    return null;
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
