/**
 * Hourly retry of a staging cleanup that failed, so a leftover staging copy
 * clears itself instead of waiting for someone to notice. Only retries when
 * the admin's last toggle asked for the copy to be removed: a copy kept on
 * purpose (staging off without removal) is never touched. The removal itself
 * is the staging route's own disable path, so it deletes only what that path
 * identifies as this app's staging.
 */

type LastToggle = { actionType?: string; burnExisting?: boolean; destroyed?: boolean } | null;

export function shouldRetryStagingCleanup(last: LastToggle): boolean {
  return Boolean(last && last.actionType === "staging_disable_requested" && last.burnExisting === true && last.destroyed === false);
}

export type StagingCleanupRetryResult = { checked: number; retried: number; cleared: number };

export async function retryFailedStagingCleanups(origin: string, limit = 3): Promise<StagingCleanupRetryResult> {
  const result: StagingCleanupRetryResult = { checked: 0, retried: 0, cleared: 0 };
  const token = process.env.OWNERSHIP_SYNC_TOKEN?.trim();
  if (!token) return result;

  const { db } = await import("@/lib/db");
  const sites: Array<{ id: string }> = await (db as any).site.findMany({
    where: { stagingEnabled: false, stagingTargetUuid: { not: null }, deletedAt: null },
    select: { id: true },
    take: 50
  });

  const { POST } = await import("@/app/api/sites/[siteId]/staging/route");
  for (const site of sites) {
    if (result.retried >= limit) break;
    result.checked += 1;
    const rows: Array<{ details: LastToggle }> = await (db as any).$queryRaw`
      SELECT details FROM "AuditLog"
      WHERE "resourceId" = ${site.id}
        AND (details->>'actionType' LIKE 'staging_disable%' OR details->>'actionType' LIKE 'staging_enable%')
      ORDER BY "createdAt" DESC
      LIMIT 1`;
    if (!shouldRetryStagingCleanup(rows[0]?.details ?? null)) continue;

    result.retried += 1;
    const response = await POST(
      new Request(`${origin}/api/sites/${site.id}/staging`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "jongo-reconcile" },
        body: JSON.stringify({ enabled: false, burnExisting: true })
      }),
      { params: Promise.resolve({ siteId: site.id }) }
    ).catch(() => null);
    const payload: any = response ? await response.json().catch(() => null) : null;
    if (payload?.destroyed) result.cleared += 1;
  }
  return result;
}
