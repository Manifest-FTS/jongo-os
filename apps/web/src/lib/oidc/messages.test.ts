import { describe, expect, it } from "vitest";
import { OIDC_ERROR_MESSAGES, oidcErrorMessage } from "./messages";

describe("oidc error messages", () => {
  it("has a distinct, honest message for a request from another origin", () => {
    const origin = oidcErrorMessage("origin");
    expect(origin.message).toBe("This request did not come from jongo.app.");
    expect(origin.next).toBe("Open the sign-in page again from the site and try once more.");
    expect(origin.title).not.toBe(oidcErrorMessage("invalid_request").title);
  });

  it("keeps invalid_request for expired or changed approval pages", () => {
    expect(oidcErrorMessage("invalid_request")).toMatchObject({ title: "Sign-in expired", next: "Return to the site and sign in again." });
  });

  it("gives every code a title, one sentence and a next step", () => {
    for (const [code, entry] of Object.entries(OIDC_ERROR_MESSAGES)) {
      expect(entry.title, code).toBeTruthy();
      expect(entry.message, code).toMatch(/\.$/);
      expect(entry.next, code).toMatch(/\.$/);
    }
  });

  it("falls back to the generic message for unknown codes, including prototype keys", () => {
    for (const code of [undefined, "", "nope", "__proto__", "constructor", "toString", "<script>alert(1)</script>"]) {
      expect(oidcErrorMessage(code)).toBe(OIDC_ERROR_MESSAGES.unavailable);
    }
  });

  it("never mentions the hosting provider or Studio", () => {
    expect(JSON.stringify(OIDC_ERROR_MESSAGES)).not.toMatch(/coolify|studio/i);
  });
});
