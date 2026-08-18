import { NextResponse } from "next/server";
import {
  authenticateWebhook,
  parseCoolifyWebhook,
  applyCoolifyDeletion
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

  const deliveryId = parsed.kind === "deletion" ? parsed.event.deliveryId : parsed.deliveryId;
  const eventType = parsed.kind === "deletion" ? parsed.event.eventType : parsed.eventType;

  if (parsed.kind === "ignored") {
    // Recorded for the audit trail, but never through applyCoolifyDeletion:
    // an ignored event was never a deletion attempt, so it needs no throttle
    // check and no site match — just a note that it arrived and why nothing happened.
    try {
      await db.webhookEvent.create({
        data: { source: "coolify", deliveryId, eventType, outcome: "skipped", detail: parsed.reason, resourceUuids: [], siteIds: [] }
      });
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code !== "P2002") {
        console.error("[jongo] coolify webhook: could not record ignored delivery", error);
      }
    }
    return NextResponse.json({ ok: true, status: "skipped", deliveryId, message: parsed.reason });
  }

  const result = await applyCoolifyDeletion({
    db,
    deliveryId,
    eventType,
    resourceUuids: parsed.event.resourceUuids,
    authMethod: auth.method,
    ipAddress: request.headers.get("x-forwarded-for") ?? "webhook",
    userAgent: request.headers.get("user-agent") ?? "coolify-webhook"
  });

  if (result.status === "failed") {
    return NextResponse.json({ ok: false, error: result.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    status: result.status,
    deliveryId: result.deliveryId,
    message: result.message,
    ...(result.archivedSiteIds ? { archivedSiteIds: result.archivedSiteIds } : {})
  });
}
