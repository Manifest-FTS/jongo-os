import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConsentView } from "@/lib/oidc/authorize";
import { OIDC_ERROR_MESSAGES } from "@/lib/oidc/messages";
import { OidcConsentCard, OidcErrorCard, initialsFor, roleLabel } from "./OidcCards";

// Vitest uses the classic JSX runtime; shared components such as BrandLogo do not import React themselves.
(globalThis as { React?: typeof React }).React = React;

const view = (over: Partial<ConsentView> = {}): ConsentView => ({
  siteName: "The Golf Lab", datasetName: "production", email: "derek@example.com", name: "Derek Domaleski",
  role: "publisher", via: "site_access", scopes: ["openid"], fields: { client_id: "c1", state: "s1", nonce: "n1" }, consentToken: "123.token", ...over
});
const html = (over?: Partial<ConsentView>) => renderToStaticMarkup(<OidcConsentCard view={view(over)} />);

describe("OidcConsentCard", () => {
  it("states who is signing in and what the site receives", () => {
    const out = html();
    expect(out).toContain("Sign in to The Golf Lab");
    expect(out).toContain("You\u2019re signing in as");
    expect(out).toContain("Derek Domaleski");
    expect(out).toContain("derek@example.com");
    expect(out).toContain(">DD<");
    expect(out).toContain("What The Golf Lab will receive");
    expect(out).toContain("Your name");
    expect(out).toContain("Your email address");
    expect(out).toContain("production");
    expect(out).toContain("It will not receive</strong> your Jongo password or access to your other apps.");
    expect(out).toContain(">Publisher<");
    expect(out).not.toContain("Jongo Super Admin");
  });

  it("keeps both submit buttons in the one consent form with their names and values", () => {
    const out = html();
    expect(out.match(/<form /g)).toHaveLength(1);
    expect(out).toContain('action="/oidc/authorize/consent"');
    expect(out).toContain('method="post"');
    expect(out).toMatch(/<button type="submit" name="decision" value="allow"[^>]*>Allow<\/button>/);
    expect(out).toMatch(/<button type="submit" name="decision" value="deny"[^>]*>Cancel<\/button>/);
    expect(out).toContain('name="consent_token" value="123.token"');
    for (const name of ["client_id", "state", "nonce"]) expect(out).toContain(`type="hidden" name="${name}"`);
  });

  it("falls back to the email when there is no name and does not claim to send one", () => {
    const out = html({ name: null });
    expect(out).toContain(">D<");
    expect(out).not.toContain("Your name");
    expect(out.match(/derek@example\.com/g)).toHaveLength(1);
  });

  it("marks a platform super admin distinctly", () => {
    const out = html({ via: "platform_admin", role: "admin" });
    expect(out).toContain("oidc-pill--platform");
    expect(out).toContain("Jongo Super Admin");
    expect(out).toContain("Jongo platform administration");
  });

  it("renders untrusted text as text, never as markup", () => {
    const evil = '<img src=x onerror=alert(1)>"\'';
    const out = html({ siteName: evil, datasetName: evil, name: evil, email: "a@b.c" });
    expect(out).not.toContain("<img src=x");
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("offers a sign-out control outside the consent form", () => {
    const out = html();
    expect(out).toMatch(/Not you\?[\s\S]*<button type="button" class="oidc-signout">Sign out<\/button>/);
    expect(out.indexOf("</form>")).toBeLessThan(out.indexOf("Not you?"));
  });

  it("hides decorative icons and avatars from assistive tech", () => {
    const out = html();
    expect(out).toMatch(/class="oidc-avatar" aria-hidden="true"/);
    expect(out.match(/<svg [^>]*aria-hidden="true"/g)?.length).toBeGreaterThanOrEqual(4);
  });
});

describe("OidcErrorCard", () => {
  it.each(Object.keys(OIDC_ERROR_MESSAGES))("renders %s with a title, a sentence and a next step", (code) => {
    const out = renderToStaticMarkup(<OidcErrorCard code={code} />);
    const { title, message, next } = OIDC_ERROR_MESSAGES[code];
    expect(out).toContain(`<h1 class="oidc-title">${title}</h1>`);
    expect(out).toContain(message);
    expect(out).toContain(next);
    expect(out).toContain("Next step");
  });

  it("uses the generic message for unknown codes and never echoes the code", () => {
    const out = renderToStaticMarkup(<OidcErrorCard code={'"><script>alert(1)</script>'} />);
    expect(out).toContain(OIDC_ERROR_MESSAGES.unavailable.title);
    expect(out).not.toContain("script");
  });
});

describe("helpers", () => {
  it("builds initials from name or email", () => {
    expect(initialsFor("Derek Domaleski", "x@y.z")).toBe("DD");
    expect(initialsFor("  prince ", "x@y.z")).toBe("P");
    expect(initialsFor("Ada Byron King", "x@y.z")).toBe("AK");
    expect(initialsFor(null, "zed@y.z")).toBe("Z");
    expect(initialsFor("", "")).toBe("?");
  });

  it("labels known roles and ignores prototype keys", () => {
    expect(["reader", "editor", "publisher", "admin"].map(roleLabel)).toEqual(["Reader", "Editor", "Publisher", "Admin"]);
    expect(roleLabel("constructor")).toBe("constructor");
  });
});
