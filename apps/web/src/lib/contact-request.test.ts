import { describe, expect, it } from "vitest";
import { LIMITS, RateLimiter, buildContactEmail, parseContactRequest } from "./contact-request";

const VALID = {
  name: "Jay Whitfield",
  email: "Jay@Northfield.CO.UK",
  company: "Northfield",
  message: "Can you migrate three sites?"
};

describe("parseContactRequest", () => {
  it("accepts a normal enquiry and normalises the address", () => {
    const r = parseContactRequest(VALID);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.email).toBe("jay@northfield.co.uk");
  });

  it("treats a filled honeypot as a bot, and says nothing that reveals the trap", () => {
    const r = parseContactRequest({ ...VALID, website: "http://spam.example" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("honeypot");
      // The copy must read like success. Naming the field teaches whoever
      // wrote the bot to leave it blank next time.
      expect(r.message).not.toMatch(/bot|spam|honeypot|blocked/i);
    }
  });

  it("checks the honeypot first, so a bot cannot learn from validation errors", () => {
    const r = parseContactRequest({ website: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("honeypot");
  });

  it("requires name, email and message", () => {
    for (const missing of ["name", "email", "message"]) {
      const r = parseContactRequest({ ...VALID, [missing]: "   " });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("missing_fields");
    }
  });

  it("treats company as optional", () => {
    expect(parseContactRequest({ ...VALID, company: "" }).ok).toBe(true);
  });

  it("rejects an address that is not one", () => {
    for (const bad of ["jay", "jay@", "@northfield.co.uk", "jay northfield.co.uk"]) {
      const r = parseContactRequest({ ...VALID, email: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("invalid_email");
    }
  });

  it("caps every field so one POST cannot deliver a novel", () => {
    const r = parseContactRequest({ ...VALID, message: "x".repeat(LIMITS.message + 1) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too_long");
  });

  it("strips control characters but keeps the newlines a message needs", () => {
    const r = parseContactRequest({ ...VALID, message: "  line one\nline two  " });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.message).toBe("line one\nline two");
      expect(r.value.message).toContain("\n");
    }
  });

  it("ignores non-string input rather than coercing it", () => {
    const r = parseContactRequest({ name: { toString: () => "x" }, email: 42, message: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing_fields");
  });
});

describe("RateLimiter", () => {
  it("allows up to the limit, then refuses with a wait", () => {
    const rl = new RateLimiter(3, 60_000);
    const t = 1_000_000;
    expect(rl.check("1.2.3.4", t).allowed).toBe(true);
    expect(rl.check("1.2.3.4", t).allowed).toBe(true);
    expect(rl.check("1.2.3.4", t).allowed).toBe(true);
    const blocked = rl.check("1.2.3.4", t);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("counts each address separately", () => {
    const rl = new RateLimiter(1, 60_000);
    expect(rl.check("a", 0).allowed).toBe(true);
    expect(rl.check("a", 0).allowed).toBe(false);
    expect(rl.check("b", 0).allowed).toBe(true);
  });

  it("lets the window roll over", () => {
    const rl = new RateLimiter(1, 60_000);
    expect(rl.check("a", 0).allowed).toBe(true);
    expect(rl.check("a", 30_000).allowed).toBe(false);
    expect(rl.check("a", 60_001).allowed).toBe(true);
  });
});

describe("buildContactEmail", () => {
  it("names the sender in the subject so an inbox can be triaged", () => {
    const { subject } = buildContactEmail({ ...VALID, email: "jay@northfield.co.uk" });
    expect(subject).toContain("Jay Whitfield");
    expect(subject).toContain("Northfield");
  });

  it("omits the bracket when there is no company", () => {
    const { subject } = buildContactEmail({ ...VALID, company: "", email: "j@x.com" });
    expect(subject).toContain("Jay Whitfield");
    expect(subject).not.toContain("(");
  });

  it("carries the reply address and the message in the body", () => {
    const { text } = buildContactEmail({ ...VALID, email: "jay@northfield.co.uk" });
    expect(text).toContain("jay@northfield.co.uk");
    expect(text).toContain("Can you migrate three sites?");
  });
});
