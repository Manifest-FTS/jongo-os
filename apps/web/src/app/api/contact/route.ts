import { NextResponse } from "next/server";
import { RateLimiter, buildContactEmail, parseContactRequest } from "@/lib/contact-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The public contact form.
 *
 * The only endpoint an anonymous stranger may POST to, so it is deliberately
 * narrow: it validates, rate-limits, and sends exactly one plain-text email to
 * one address read from configuration. Nothing the caller sends decides where
 * the mail goes.
 *
 * The rules themselves live in lib/contact-request.ts, with tests.
 */

// Module scope so the counter survives between requests in a warm process.
const limiter = new RateLimiter(5, 10 * 60 * 1000);

/** Best-effort client address. Behind Cloudflare and Traefik this is a header. */
function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  const first = forwarded.split(",")[0]?.trim();
  return first || request.headers.get("cf-connecting-ip")?.trim() || request.headers.get("x-real-ip")?.trim() || "unknown";
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const parsed = parseContactRequest(body ?? {});

  if (!parsed.ok) {
    // A caught bot is answered with 200 and the same wording a person gets.
    // Anything else would tell whoever wrote it exactly which field to drop.
    if (parsed.reason === "honeypot") {
      return NextResponse.json({ ok: true, message: parsed.message });
    }
    return NextResponse.json({ ok: false, reason: parsed.reason, message: parsed.message }, { status: 400 });
  }

  const gate = limiter.check(clientKey(request));
  if (!gate.allowed) {
    return NextResponse.json(
      {
        ok: false,
        reason: "rate_limited",
        message: "That is a few messages in a short time. Please try again shortly, or email us directly."
      },
      { status: 429, headers: { "Retry-After": String(gate.retryAfterSeconds) } }
    );
  }

  // DELIVERY address — internal, never rendered. This may fall back to
  // SMTP_FROM; the address shown on the public pages deliberately may not (see
  // lib/public-site.ts).
  const inbox = (process.env.CONTACT_INBOX_EMAIL || process.env.SMTP_FROM || "").trim();
  if (!inbox) {
    // Never pretend. A form that reports "message sent" into a void is the
    // exact failure this codebase keeps having to undo.
    console.error("contact: no CONTACT_INBOX_EMAIL or SMTP_FROM configured; message not sent");
    return NextResponse.json(
      {
        ok: false,
        reason: "not_configured",
        message: "The contact form is not connected to an inbox yet. Please email us directly for now."
      },
      { status: 503 }
    );
  }

  const { sendTransactionalEmail } = await import("@/lib/email");
  const { subject, text } = buildContactEmail(parsed.value);

  const result = await sendTransactionalEmail({ to: inbox, subject, text });

  if (!result.sent) {
    console.error("contact: send failed", result.provider, result.error);
    return NextResponse.json(
      {
        ok: false,
        reason: "send_failed",
        message: "We could not send that just now. Please try again, or email us directly."
      },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true, message: "Thanks — we will be in touch." });
}
