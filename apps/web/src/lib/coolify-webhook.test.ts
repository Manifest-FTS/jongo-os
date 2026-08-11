import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  SIGNATURE_TOLERANCE_SECONDS,
  WEBHOOK_DELETION_BURST_LIMIT,
  authenticateWebhook,
  deriveDeliveryId,
  parseCoolifyWebhook,
  shouldThrottleWebhookDeletion
} from "./coolify-webhook";

const HMAC_SECRET = "hmac-secret";
const TOKEN = "token-secret";
const now = new Date("2026-08-10T12:00:00Z");
const ts = String(Math.floor(now.getTime() / 1000));

function sign(rawBody: string, timestamp = ts, secret = HMAC_SECRET): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

describe("authenticateWebhook", () => {
  const body = '{"event":"application.deleted","uuid":"abc"}';

  it("fails closed when no secret is configured", () => {
    // An unauthenticated endpoint that archives customer records is worse than
    // no endpoint at all.
    expect(authenticateWebhook({ rawBody: body, signature: sign(body), timestamp: ts, now })).toEqual({
      ok: false,
      reason: "not_configured"
    });
  });

  it("accepts a valid signature", () => {
    expect(
      authenticateWebhook({ rawBody: body, signature: sign(body), timestamp: ts, hmacSecret: HMAC_SECRET, now })
    ).toEqual({ ok: true, method: "hmac" });
  });

  it("accepts the sha256= prefix form", () => {
    expect(
      authenticateWebhook({
        rawBody: body,
        signature: `sha256=${sign(body)}`,
        timestamp: ts,
        hmacSecret: HMAC_SECRET,
        now
      }).ok
    ).toBe(true);
  });

  it("rejects a signature over different bytes", () => {
    const result = authenticateWebhook({
      rawBody: '{"event":"application.deleted","uuid":"OTHER"}',
      signature: sign(body),
      timestamp: ts,
      hmacSecret: HMAC_SECRET,
      now
    });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a signature made with the wrong secret", () => {
    const result = authenticateWebhook({
      rawBody: body,
      signature: sign(body, ts, "attacker"),
      timestamp: ts,
      hmacSecret: HMAC_SECRET,
      now
    });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a signature with no timestamp, which would replay forever", () => {
    expect(
      authenticateWebhook({ rawBody: body, signature: sign(body), timestamp: null, hmacSecret: HMAC_SECRET, now })
    ).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("rejects a replay outside the tolerance window", () => {
    const old = String(Math.floor(now.getTime() / 1000) - (SIGNATURE_TOLERANCE_SECONDS + 60));
    expect(
      authenticateWebhook({ rawBody: body, signature: sign(body, old), timestamp: old, hmacSecret: HMAC_SECRET, now })
    ).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("rejects a future timestamp just as firmly", () => {
    const future = String(Math.floor(now.getTime() / 1000) + (SIGNATURE_TOLERANCE_SECONDS + 60));
    expect(
      authenticateWebhook({ rawBody: body, signature: sign(body, future), timestamp: future, hmacSecret: HMAC_SECRET, now })
      .ok
    ).toBe(false);
  });

  it("rejects a non-numeric timestamp instead of treating it as 0", () => {
    expect(
      authenticateWebhook({ rawBody: body, signature: sign(body, "abc"), timestamp: "abc", hmacSecret: HMAC_SECRET, now })
    ).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("accepts a matching token, since Coolify's sender cannot sign", () => {
    expect(authenticateWebhook({ rawBody: body, presentedToken: TOKEN, tokenSecret: TOKEN, now })).toEqual({
      ok: true,
      method: "token"
    });
  });

  it("rejects a wrong token", () => {
    expect(authenticateWebhook({ rawBody: body, presentedToken: "nope", tokenSecret: TOKEN, now })).toEqual({
      ok: false,
      reason: "bad_token"
    });
  });

  it("rejects a delivery presenting no credential at all", () => {
    expect(authenticateWebhook({ rawBody: body, hmacSecret: HMAC_SECRET, tokenSecret: TOKEN, now })).toEqual({
      ok: false,
      reason: "missing_credential"
    });
  });

  it("does not fall back to the token when a signature is present but wrong", () => {
    // Otherwise a bad signature plus a leaked URL token would still get in.
    const result = authenticateWebhook({
      rawBody: body,
      signature: sign(body, ts, "attacker"),
      timestamp: ts,
      presentedToken: TOKEN,
      hmacSecret: HMAC_SECRET,
      tokenSecret: TOKEN,
      now
    });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });
});

describe("parseCoolifyWebhook", () => {
  it("recognises a deletion and its resource uuid", () => {
    const parsed = parseCoolifyWebhook('{"event":"application.deleted","uuid":"svc-1"}');
    expect(parsed.kind).toBe("deletion");
    if (parsed.kind !== "deletion") return;
    expect(parsed.event.resourceUuids).toEqual(["svc-1"]);
  });

  it("reads ids nested under a resource object", () => {
    const parsed = parseCoolifyWebhook('{"event":"resource.destroyed","resource":{"uuid":"svc-2","kind":"service"}}');
    expect(parsed.kind).toBe("deletion");
    if (parsed.kind !== "deletion") return;
    expect(parsed.event.resourceUuids).toEqual(["svc-2"]);
    expect(parsed.event.resourceKind).toBe("service");
  });

  it("accepts a list of uuids and dedupes it", () => {
    const parsed = parseCoolifyWebhook('{"event":"deleted","uuid":"a","uuids":["a","b"]}');
    expect(parsed.kind === "deletion" && parsed.event.resourceUuids).toEqual(["a", "b"]);
  });

  it("ignores a non-deletion event rather than guessing", () => {
    const parsed = parseCoolifyWebhook('{"event":"deployment.success","uuid":"svc-1"}');
    expect(parsed.kind).toBe("ignored");
  });

  it("ignores a deletion that names no resource", () => {
    // Acting on this would mean choosing a victim.
    const parsed = parseCoolifyWebhook('{"event":"application.deleted"}');
    expect(parsed.kind).toBe("ignored");
    expect(parsed.kind === "ignored" && parsed.reason).toContain("no resource uuid");
  });

  it("rejects a non-JSON or non-object body", () => {
    expect(parseCoolifyWebhook("not json").kind).toBe("invalid");
    expect(parseCoolifyWebhook("[1,2]").kind).toBe("invalid");
  });

  it("prefers the sender's delivery id when it supplies one", () => {
    const parsed = parseCoolifyWebhook('{"delivery_id":"d-1","event":"deleted","uuid":"a"}');
    expect(parsed.kind === "deletion" && parsed.event.deliveryId).toBe("d-1");
  });

  it("derives a stable delivery id when the sender gives none", () => {
    // Idempotency has to survive a sender that does not identify its deliveries.
    const body = '{"event":"deleted","uuid":"a"}';
    const first = parseCoolifyWebhook(body);
    const second = parseCoolifyWebhook(body);
    expect(first.kind === "deletion" && first.event.deliveryId).toBe(deriveDeliveryId(body));
    expect(second.kind === "deletion" && second.event.deliveryId).toBe(
      first.kind === "deletion" ? first.event.deliveryId : ""
    );
  });

  it("gives different bodies different derived ids", () => {
    expect(deriveDeliveryId('{"uuid":"a"}')).not.toBe(deriveDeliveryId('{"uuid":"b"}'));
  });
});

describe("shouldThrottleWebhookDeletion", () => {
  it("allows normal single deletions", () => {
    expect(shouldThrottleWebhookDeletion({ recentDeletions: 0 }).throttle).toBe(false);
    expect(shouldThrottleWebhookDeletion({ recentDeletions: WEBHOOK_DELETION_BURST_LIMIT - 1 }).throttle).toBe(false);
  });

  it("stops a burst, which is more likely a fault or a stolen token than reality", () => {
    const decision = shouldThrottleWebhookDeletion({ recentDeletions: WEBHOOK_DELETION_BURST_LIMIT });
    expect(decision.throttle).toBe(true);
    expect(decision.reason).toContain("limit");
  });
});
