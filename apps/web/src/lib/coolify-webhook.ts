/**
 * Inbound webhook handling for Coolify resource-deletion events.
 *
 * A caveat that shapes the whole design: Coolify does not emit a deletion
 * webhook. Its notification set has no deletion event (deletion runs through
 * DeleteResourceJob / Actions\*\DeleteService, which notify nothing), and its
 * sender — SendWebhookJob — posts with `Http::post($url, $payload)`, so it can
 * carry no signature and no auth header either.
 *
 * That means:
 *   - authentication has to accept a URL/header TOKEN, not only an HMAC, or
 *     nothing Coolify can send would ever authenticate;
 *   - the guaranteed Coolify->Jongo path today remains the hourly reconciler,
 *     which sets Site.resourceMissingSince and archives after a grace period.
 *     This endpoint makes the same reconciliation IMMEDIATE for any sender that
 *     can call it (an ops hook on the host, our own tooling, a future Coolify
 *     that gains the event) — it does not replace that fallback.
 *
 * The parts that are easy to get quietly wrong — constant-time signature
 * comparison, the replay window, and pulling resource ids out of payloads whose
 * shape we do not control — live here so they are testable without a request.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export type WebhookAuthResult =
  | { ok: true; method: "hmac" | "token" }
  | { ok: false; reason: "not_configured" | "missing_credential" | "bad_signature" | "stale_timestamp" | "bad_token" };

/**
 * Timing-safe comparison that does not leak length either.
 *
 * timingSafeEqual throws on unequal lengths, and returning early on that would
 * expose the digest length; hashing both sides first makes every comparison the
 * same width.
 */
function safeEqual(a: string, b: string): boolean {
  const ha = createHmac("sha256", "cmp").update(a).digest();
  const hb = createHmac("sha256", "cmp").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Authenticate a webhook delivery.
 *
 * HMAC is preferred and is checked first. The token path exists solely because
 * Coolify cannot sign; it is weaker (a URL token ends up in access logs), so it
 * is accepted only when a token secret is explicitly configured.
 *
 * Fails CLOSED: with no secret configured at all, nothing authenticates. An
 * unauthenticated endpoint that deletes records is worse than no endpoint.
 */
export function authenticateWebhook(input: {
  rawBody: string;
  signature?: string | null;
  timestamp?: string | null;
  presentedToken?: string | null;
  hmacSecret?: string | null;
  tokenSecret?: string | null;
  now?: Date;
  toleranceSeconds?: number;
}): WebhookAuthResult {
  const hmacSecret = input.hmacSecret?.trim() || "";
  const tokenSecret = input.tokenSecret?.trim() || "";
  if (!hmacSecret && !tokenSecret) {
    return { ok: false, reason: "not_configured" };
  }

  const signature = input.signature?.trim() || "";
  if (hmacSecret && signature) {
    // A signature without a timestamp is replayable forever.
    const timestamp = input.timestamp?.trim() || "";
    if (!timestamp) return { ok: false, reason: "stale_timestamp" };

    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds)) return { ok: false, reason: "stale_timestamp" };

    const now = (input.now ?? new Date()).getTime() / 1000;
    const tolerance = input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
    if (Math.abs(now - seconds) > tolerance) return { ok: false, reason: "stale_timestamp" };

    // The timestamp is inside the signed material, so it cannot be altered to
    // move the replay window.
    const expected = createHmac("sha256", hmacSecret).update(`${timestamp}.${input.rawBody}`).digest("hex");
    const presented = signature.replace(/^sha256=/i, "");
    return safeEqual(expected, presented) ? { ok: true, method: "hmac" } : { ok: false, reason: "bad_signature" };
  }

  const presentedToken = input.presentedToken?.trim() || "";
  if (tokenSecret && presentedToken) {
    return safeEqual(tokenSecret, presentedToken) ? { ok: true, method: "token" } : { ok: false, reason: "bad_token" };
  }

  return { ok: false, reason: "missing_credential" };
}

export type WebhookDeletionEvent = {
  /** Stable id for idempotency. Derived from the body when the sender gives none. */
  deliveryId: string;
  /** Coolify uuids the event refers to. Usually one. */
  resourceUuids: string[];
  /** 'application' | 'service' | 'database' | 'unknown' — informational only. */
  resourceKind: string;
  /** The raw event name, kept for the log. */
  eventType: string;
};

export type ParsedWebhook =
  | { kind: "deletion"; event: WebhookDeletionEvent }
  | { kind: "ignored"; reason: string; eventType: string; deliveryId: string }
  | { kind: "invalid"; reason: string };

const DELETION_EVENT_PATTERN = /(deleted|destroyed|removed|delete)/i;

function firstString(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** Stable id from the payload itself, so a re-delivery still dedupes. */
export function deriveDeliveryId(rawBody: string): string {
  return createHmac("sha256", "delivery-id").update(rawBody).digest("hex").slice(0, 40);
}

/**
 * Normalize a delivery into something the handler can act on.
 *
 * Deliberately permissive about SHAPE and strict about MEANING: the sender's
 * schema is not ours to control, so several key spellings are accepted, but an
 * event is only treated as a deletion when it says so and names a resource.
 * Anything else is `ignored` rather than guessed at — the cost of a wrong guess
 * here is deleting a customer's record.
 */
export function parseCoolifyWebhook(rawBody: string): ParsedWebhook {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { kind: "invalid", reason: "body was not valid JSON" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { kind: "invalid", reason: "body was not a JSON object" };
  }

  const body = payload as Record<string, unknown>;
  const deliveryId = firstString(body, ["delivery_id", "deliveryId", "id", "event_id"]) || deriveDeliveryId(rawBody);
  const eventType = firstString(body, ["event", "event_type", "eventType", "type", "action", "status"]) || "unknown";

  if (!DELETION_EVENT_PATTERN.test(eventType)) {
    return { kind: "ignored", reason: `event type is not a deletion (${eventType})`, eventType, deliveryId };
  }

  // Ids can arrive at the top level, nested under a resource object, or as a list.
  const nested = (() => {
    for (const key of ["resource", "data", "payload", "application", "service", "database"]) {
      const value = body[key];
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    }
    return {};
  })();

  const single =
    firstString(body, ["uuid", "resource_uuid", "resourceUuid", "service_uuid", "application_uuid"]) ||
    firstString(nested, ["uuid", "resource_uuid", "resourceUuid", "service_uuid", "application_uuid"]);

  const listed = Array.isArray(body.uuids)
    ? body.uuids.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((v) => v.trim())
    : [];

  const resourceUuids = Array.from(new Set([single, ...listed].filter(Boolean)));
  if (resourceUuids.length === 0) {
    return { kind: "ignored", reason: "deletion event named no resource uuid", eventType, deliveryId };
  }

  const resourceKind =
    firstString(body, ["resource_type", "resourceType", "kind"]) ||
    firstString(nested, ["resource_type", "resourceType", "kind"]) ||
    (body.service ? "service" : body.application ? "application" : body.database ? "database" : "unknown");

  return { kind: "deletion", event: { deliveryId, resourceUuids, resourceKind, eventType } };
}

export const WEBHOOK_DELETION_BURST_LIMIT = 5;

/**
 * Refuse an implausible burst of deletions.
 *
 * The reconciler already has this protection (shouldAbortArchiveBatch aborts a
 * batch when more than a quarter of sites look deleted) on the reasoning that a
 * mass deletion is far more likely a Coolify or API fault than reality. A webhook
 * needs it too, and more urgently: it acts immediately and one caller with a
 * token could otherwise walk the fleet.
 */
export function shouldThrottleWebhookDeletion(input: {
  recentDeletions: number;
  limit?: number;
}): { throttle: boolean; reason: string } {
  const limit = input.limit ?? WEBHOOK_DELETION_BURST_LIMIT;
  if (input.recentDeletions >= limit) {
    return {
      throttle: true,
      reason: `${input.recentDeletions} webhook deletions already applied in the last hour (limit ${limit})`
    };
  }
  return { throttle: false, reason: "within_limit" };
}
