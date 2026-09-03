/**
 * Validating a message from the public contact form.
 *
 * This is the only endpoint on the platform an anonymous stranger can POST to,
 * so the rules live here rather than inline in the route: they are the part
 * that has to be right, and they are testable without a mail server.
 *
 * Everything is treated as hostile input. The message is delivered as PLAIN
 * TEXT and any HTML rendering escapes it — a contact form is a direct path from
 * a stranger's keyboard into somebody's inbox.
 */

export type ContactRequestInput = {
  name?: unknown;
  email?: unknown;
  company?: unknown;
  message?: unknown;
  /** Hidden field. A human never sees it, so anything in it is a bot. */
  website?: unknown;
};

export type ContactRequestResult =
  | { ok: true; value: { name: string; email: string; company: string; message: string } }
  | { ok: false; reason: "honeypot" | "missing_fields" | "invalid_email" | "too_long"; message: string };

export const LIMITS = { name: 120, email: 200, company: 160, message: 4000 } as const;

/** Strip control characters, keeping the newlines a message legitimately has. */
function clean(value: unknown, keepNewlines = false): string {
  if (typeof value !== "string") return "";
  const stripped = value.replace(/[\x00-\x1f\x7f]/g, (ch) => (keepNewlines && (ch === "\n" || ch === "\r") ? ch : ""));
  return stripped.trim();
}

export function parseContactRequest(input: ContactRequestInput): ContactRequestResult {
  // Checked FIRST and answered like a success by the caller: telling a bot it
  // was caught only teaches whoever wrote it to drop the field.
  if (clean(input.website)) {
    return { ok: false, reason: "honeypot", message: "Thanks — we will be in touch." };
  }

  const name = clean(input.name);
  const email = clean(input.email).toLowerCase();
  const company = clean(input.company);
  const message = clean(input.message, true);

  if (!name || !email || !message) {
    return { ok: false, reason: "missing_fields", message: "Please fill in your name, email and message." };
  }

  // The same shape the registration route accepts, so one form cannot be
  // stricter than the other about what an address looks like.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, reason: "invalid_email", message: "That email address does not look right." };
  }

  if (
    name.length > LIMITS.name ||
    email.length > LIMITS.email ||
    company.length > LIMITS.company ||
    message.length > LIMITS.message
  ) {
    return { ok: false, reason: "too_long", message: "That message is longer than we can accept." };
  }

  return { ok: true, value: { name, email, company, message } };
}

/**
 * A fixed-window counter, per key, in memory.
 *
 * Deliberately modest: it blunts a script hammering the form from one address,
 * and it is honest about what it is not — process-local, so it resets on deploy
 * and does not coordinate across instances. The real backstop is that the
 * endpoint only ever sends one plain-text email to one fixed address.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}

  check(key: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    const entry = this.hits.get(key);

    if (!entry || now >= entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      // Opportunistic sweep: without it the map grows for the life of the
      // process, one entry per address that ever posted.
      if (this.hits.size > 5000) {
        for (const [k, v] of this.hits) if (now >= v.resetAt) this.hits.delete(k);
      }
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (entry.count >= this.limit) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
    }

    entry.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

/** Build the plain-text body. Submitted values are never treated as HTML. */
export function buildContactEmail(value: {
  name: string;
  email: string;
  company: string;
  message: string;
}): { subject: string; text: string } {
  return {
    subject: `Contact form — ${value.name}${value.company ? ` (${value.company})` : ""}`,
    text: [
      `Name:    ${value.name}`,
      `Email:   ${value.email}`,
      `Company: ${value.company || "—"}`,
      "",
      value.message,
      "",
      "— sent from the Jongo contact form"
    ].join("\n")
  };
}
