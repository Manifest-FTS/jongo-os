import { NextResponse } from "next/server";
import { coolifyFetch } from "@/lib/coolify";
import { applyCoolifyDeletion } from "@/lib/coolify-webhook";
import {
  DEFAULT_CONFIRM_MINUTES,
  DEFAULT_MAX_DROP_FRACTION,
  isDeletionConfirmed,
  shouldTrustPoll
} from "@/lib/coolify-deletion-watch";

export const runtime = "nodejs";

/**
 * POST /api/ops/coolify-deletion-watch
 *
 * The fast half of deletion sync. Ticked every minute by
 * scripts/coolify-deletion-watcher.mjs, in the same shape as the backup reconcile
 * scheduler: the loop lives in a tiny .mjs, all the logic lives here.
 *
 * Coolify emits no deletion event, so a deletion has to be noticed rather than
 * received. One call to Coolify's resource index per tick answers it
 * authoritatively, and unlike container events it is not confused by the destroy/
 * recreate churn of an ordinary deploy.
 *
 * This decides only WHEN to speak. Applying the deletion stays with
 * lib/coolify-webhook's applyCoolifyDeletion — the same function
 * /api/webhooks/coolify calls — so the fast path and any external sender
 * converge on one applier and one audit trail. It is called directly, in
 * process, rather than over HTTP: a route handler fetching its own server's
 * URL is a known source of flaky "fetch failed" errors in Next.js, and this
 * tick already runs inside that same server.
 *
 * The reconciler's seven-day archive remains untouched as the conservative
 * backstop: if this process is not running, deletions still sync, just slowly.
 */
export async function POST(request: Request) {
  const opsToken = process.env.BACKUP_RECONCILE_TOKEN?.trim() || process.env.OWNERSHIP_SYNC_TOKEN?.trim();
  const provided = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!opsToken || !provided || provided !== opsToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const confirmMinutes = Number(process.env.COOLIFY_DELETION_CONFIRM_MINUTES || DEFAULT_CONFIRM_MINUTES) || DEFAULT_CONFIRM_MINUTES;
  const maxDropFraction = Number(process.env.COOLIFY_DELETION_MAX_DROP_FRACTION || DEFAULT_MAX_DROP_FRACTION) || DEFAULT_MAX_DROP_FRACTION;

  try {
    const { db } = await import("@/lib/db");

    let liveUuids: string[];
    try {
      const payload = await coolifyFetch("/api/v1/resources");
      if (!Array.isArray(payload)) {
        // Not an error worth retrying differently — just an untrustworthy answer.
        return NextResponse.json({ ok: true, status: "skipped", reason: "resource index was not an array" });
      }
      liveUuids = (payload as Array<Record<string, unknown>>)
        .map((row) => String(row?.uuid ?? row?.id ?? "").trim())
        .filter(Boolean);
    } catch (error) {
      // A failed poll must never advance anything: an outage cannot be allowed to
      // accumulate into a deletion.
      return NextResponse.json({
        ok: true,
        status: "skipped",
        reason: `could not read Coolify resources: ${error instanceof Error ? error.message : "unknown"}`
      });
    }

    const sites = await db.site.findMany({
      where: { deletedAt: null, NOT: [{ coolifyServiceUuid: null }] },
      select: { id: true, slug: true, coolifyServiceUuid: true, resourceMissingSince: true }
    });

    // Baseline is the number of linked apps, not a remembered count: it needs no
    // state, and it is the quantity that actually matters — if Coolify reports far
    // fewer resources than we have apps, the answer is not believable.
    const trust = shouldTrustPoll({
      currentCount: liveUuids.length,
      lastGoodCount: sites.length,
      maxDropFraction
    });
    if (!trust.trust) {
      console.error(`[jongo] deletion watch distrusted poll: ${trust.reason}`);
      return NextResponse.json({ ok: true, status: "distrusted", reason: trust.reason, liveCount: liveUuids.length });
    }

    const live = new Set(liveUuids);
    const now = new Date();
    let flagged = 0;
    let cleared = 0;
    const confirmed: Array<{ id: string; slug: string; uuid: string; ageMinutes: number }> = [];

    for (const site of sites) {
      const uuid = site.coolifyServiceUuid?.trim();
      if (!uuid) continue;

      if (live.has(uuid)) {
        // Present again: clear any prior suspicion so a flicker cannot mature
        // into a deletion.
        if (site.resourceMissingSince) {
          await db.site.update({ where: { id: site.id }, data: { resourceMissingSince: null } });
          cleared += 1;
        }
        continue;
      }

      if (!site.resourceMissingSince) {
        // First sighting of absence. Only stamped — never acted on in the same
        // tick, so a single bad response cannot delete anything.
        await db.site.update({ where: { id: site.id }, data: { resourceMissingSince: now } });
        flagged += 1;
        continue;
      }

      const verdict = isDeletionConfirmed({ missingSince: site.resourceMissingSince, now, confirmMinutes });
      if (verdict.confirmed) {
        confirmed.push({ id: site.id, slug: site.slug, uuid, ageMinutes: verdict.ageMinutes });
      }
    }

    const reported: Array<{ slug: string; status: string }> = [];
    for (const candidate of confirmed) {
      // Bucketed by hour, same as the old HTTP delivery_id: a retry within the
      // hour dedupes on WebhookEvent's unique index, while a resource genuinely
      // re-created and re-deleted later still gets through.
      const deliveryId = `watcher-${candidate.uuid}-${Math.floor(Date.now() / 3_600_000)}`;
      const result = await applyCoolifyDeletion({
        db,
        deliveryId,
        eventType: "resource.deleted",
        resourceUuids: [candidate.uuid],
        authMethod: "internal-watcher"
      });
      reported.push({ slug: candidate.slug, status: result.status });
    }

    return NextResponse.json({
      ok: true,
      status: "ok",
      liveCount: liveUuids.length,
      linkedApps: sites.length,
      flagged,
      cleared,
      confirmMinutes,
      confirmed: confirmed.map((c) => ({ slug: c.slug, uuid: c.uuid, ageMinutes: c.ageMinutes })),
      reported
    });
  } catch (error) {
    return NextResponse.json(
      { error: `deletion watch failed: ${error instanceof Error ? error.message : "unknown"}` },
      { status: 500 }
    );
  }
}

