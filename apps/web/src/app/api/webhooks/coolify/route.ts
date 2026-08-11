import { NextResponse } from "next/server";
import {
  authenticateWebhook,
  parseCoolifyWebhook,
  shouldThrottleWebhookDeletion
} from "@/lib/coolify-webhook";

export const runtime = "nodejs";

/**
 * POST /api/webhooks/coolify
 *
 * Applies a Coolify resource-deletion event to the matching Jongo site.
 *
 * Read lib/coolify-webhook.ts first: Coolify has no deletion webhook, so nothing
 * upstream calls this today. It exists as the immediate path for senders that
 * CAN call it (an ops hook on the host, our own tooling), while the hourly
 * reconciler remains the guaranteed fallback via Site.resourceMissingSince.
 *
 * Response codes are chosen for how senders behave, not for tidiness:
 *   401 — bad or missing credential (a retry with the same credential is futile,
 *         but the sender should see it was rejected).
 *   400 — unparseable body.
 *   200 — anything we understood, INCLUDING skipped and unmatched. A sender that
 *         gets a 5xx retries in a loop; "I understood this and chose not to act"
 *         is not a failure to retry.
 *   500 — only when our own storage broke, which IS worth retrying.
 */
export async function POST(request: Request) {
  // The raw body is required for the signature: re-serializing parsed JSON
  // changes bytes (key order, spacing) and the HMAC would never match.
  const rawBody = await request.text();

  const url = new URL(request.url);
  const auth = authenticateWebhook({
    rawBody,
    signature: request.headers.get("x-jongo-signature"),
    timestamp: request.headers.get("x-jongo-timestamp"),
    // Header first; the query form exists only because Coolify's sender can
    // carry nothing but a URL. It leaks into access logs, so it is the fallback.
    presentedToken: request.headers.get("x-jongo-webhook-token") ?? url.searchParams.get("token"),
    hmacSecret: process.env.COOLIFY_WEBHOOK_HMAC_SECRET,
    tokenSecret: process.env.COOLIFY_WEBHOOK_TOKEN
  });

  if (!auth.ok) {
    // Deliberately not logged to WebhookEvent: an unauthenticated caller must not
    // be able to fill that table.
    console.warn(`[jongo] coolify webhook rejected: ${auth.reason}`);
    return NextResponse.json(
      {
        ok: false,
        error:
          auth.reason === "not_configured"
            ? "Webhook receiving is not configured on this instance."
            : "Unauthorized webhook delivery."
      },
      { status: auth.reason === "not_configured" ? 503 : 401 }
    );
  }

  const parsed = parseCoolifyWebhook(rawBody);
  if (parsed.kind === "invalid") {
    return NextResponse.json({ ok: false, error: parsed.reason }, { status: 400 });
  }

  const { db } = await import("@/lib/db");

  // Claim the delivery id first. The unique index is the idempotency mechanism:
  // a concurrent or retried delivery loses this insert and stops here, so the
  // deletion cannot be applied twice.
  const deliveryId = parsed.kind === "deletion" ? parsed.event.deliveryId : parsed.deliveryId;
  const eventType = parsed.kind === "deletion" ? parsed.event.eventType : parsed.eventType;
  const resourceUuids = parsed.kind === "deletion" ? parsed.event.resourceUuids : [];

  let claimed: { id: string } | null = null;
  try {
    claimed = await db.webhookEvent.create({
      data: { source: "coolify", deliveryId, eventType, outcome: "received", resourceUuids, siteIds: [] },
      select: { id: true }
    });
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === "P2002") {
      return NextResponse.json({ ok: true, status: "duplicate", deliveryId, message: "Delivery already processed." });
    }
    console.error("[jongo] coolify webhook: could not record delivery", error);
    // Our storage failed, so idempotency cannot be guaranteed — ask for a retry.
    return NextResponse.json({ ok: false, error: "Could not record the delivery." }, { status: 500 });
  }

  const finish = async (outcome: string, detail: string | null, siteIds: string[] = []) => {
    try {
      await db.webhookEvent.update({ where: { id: claimed!.id }, data: { outcome, detail, siteIds } });
    } catch (error) {
      console.error("[jongo] coolify webhook: could not update delivery outcome", error);
    }
    return { outcome, detail, siteIds };
  };

  if (parsed.kind === "ignored") {
    await finish("skipped", parsed.reason);
    return NextResponse.json({ ok: true, status: "skipped", deliveryId, message: parsed.reason });
  }

  try {
    // Map Coolify ids to Jongo records. Both columns are checked because an app
    // may be linked by either, and already-deleted rows are excluded so a repeat
    // is a no-op rather than a second write.
    const sites = await db.site.findMany({
      where: {
        deletedAt: null,
        OR: [
          { coolifyServiceUuid: { in: resourceUuids } },
          { coolifyServiceId: { in: resourceUuids } }
        ]
      },
      select: { id: true, slug: true, name: true, organizationId: true }
    }) as Array<{ id: string; slug: string; name: string; organizationId: string }>;

    if (sites.length === 0) {
      // Not an error: Coolify holds plenty of resources Jongo never adopted.
      const detail = `no Jongo site is linked to ${resourceUuids.join(", ")}`;
      await finish("unmatched", detail);
      return NextResponse.json({ ok: true, status: "unmatched", deliveryId, message: detail });
    }

    const recentDeletions = await db.webhookEvent.count({
      where: {
        source: "coolify",
        outcome: "applied",
        receivedAt: { gte: new Date(Date.now() - 60 * 60 * 1000) }
      }
    });
    const throttle = shouldThrottleWebhookDeletion({ recentDeletions });
    if (throttle.throttle) {
      // Mirrors the reconciler's mass-deletion circuit breaker. A flood of
      // deletions is far more likely a Coolify fault or a stolen token than
      // reality, and this path acts immediately.
      await finish("throttled", throttle.reason, sites.map((site) => site.id));
      console.error(`[jongo] coolify webhook throttled: ${throttle.reason}`);
      return NextResponse.json(
        { ok: true, status: "throttled", deliveryId, message: throttle.reason },
        { status: 200 }
      );
    }

    const now = new Date();
    // SOFT delete only. Same reasoning as decideSiteArchive: the record still
    // holds backup history and team links, and a webhook acting on someone else's
    // mistake has to be reversible.
    await db.site.updateMany({
      where: { id: { in: sites.map((site) => site.id) }, deletedAt: null },
      data: { deletedAt: now }
    });

    for (const site of sites) {
      try {
        await db.auditLog.create({
          data: {
            organizationId: site.organizationId,
            actorId: null,
            action: "site_deleted",
            resourceType: "site",
            resourceId: site.id,
            details: {
              actionType: "coolify_webhook_deletion_synced",
              deliveryId,
              eventType,
              resourceUuids,
              authMethod: auth.method,
              message: `Coolify reported this resource deleted; the Jongo app was archived to match.`
            },
            ipAddress: request.headers.get("x-forwarded-for") ?? "webhook",
            userAgent: request.headers.get("user-agent") ?? "coolify-webhook"
          }
        });
      } catch (error) {
        // The site is already archived; a missing audit row must not undo that.
        console.error(`[jongo] coolify webhook: audit log failed for ${site.id}`, error);
      }
    }

    const siteIds = sites.map((site) => site.id);
    await finish("applied", null, siteIds);

    return NextResponse.json({
      ok: true,
      status: "applied",
      deliveryId,
      archivedSiteIds: siteIds,
      message: `Archived ${sites.length} Jongo app${sites.length === 1 ? "" : "s"} to match Coolify.`
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 300) : "unknown error";
    await finish("failed", detail);
    console.error("[jongo] coolify webhook: apply failed", error);
    return NextResponse.json({ ok: false, error: `Could not apply the deletion: ${detail}` }, { status: 500 });
  }
}
