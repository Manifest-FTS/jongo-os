import { describe, expect, it } from "vitest";
import {
  authenticateClientSecret, checkRedirectUriForRegistration, findActiveClient, generateClientId, generateClientSecret,
  hashClientSecret, isClientIdShape, redirectUriMatches, verifyClientSecret
} from "./clients";
import { CLIENT_ID, CLIENT_SECRET, FakeOidcDb, makeClient } from "./testing";
// @ts-expect-error plain .mjs operator script, no type declarations
import { hashClientSecret as scriptHash, checkRedirectUri as scriptCheck } from "../../../../../scripts/oidc-register-client.mjs";

const REGISTERED = ["https://site.example/craft/auth/callback"];

describe("redirect URI exact match", () => {
  it("accepts only the registered string", () => {
    expect(redirectUriMatches(REGISTERED, "https://site.example/craft/auth/callback")).toBe(true);
  });

  it.each([
    ["trailing slash", "https://site.example/craft/auth/callback/"],
    ["upper-case host", "https://SITE.example/craft/auth/callback"],
    ["upper-case path", "https://site.example/Craft/auth/callback"],
    ["default port", "https://site.example:443/craft/auth/callback"],
    ["other port", "https://site.example:8443/craft/auth/callback"],
    ["userinfo", "https://user@site.example/craft/auth/callback"],
    ["userinfo trick", "https://site.example@evil.example/craft/auth/callback"],
    ["fragment", "https://site.example/craft/auth/callback#x"],
    ["query appended", "https://site.example/craft/auth/callback?next=//evil.example"],
    ["subdomain suffix", "https://site.example.evil.example/craft/auth/callback"],
    ["prefix match", "https://site.example/craft/auth/callback/../../x"],
    ["path traversal", "https://site.example/craft/auth/callback/.."],
    ["encoded slash", "https://site.example/craft%2Fauth/callback"],
    ["double encoding", "https://site.example/craft/auth/callback%2f"],
    ["backslash", "https://site.example\\craft/auth/callback"],
    ["scheme downgrade", "http://site.example/craft/auth/callback"],
    ["protocol relative", "//site.example/craft/auth/callback"],
    ["whitespace", " https://site.example/craft/auth/callback"],
    ["trailing whitespace", "https://site.example/craft/auth/callback "],
    ["newline", "https://site.example/craft/auth/callback\n"],
    ["null byte", "https://site.example/craft/auth/callback\u0000"],
    ["open redirect", "https://evil.example"],
    ["javascript scheme", "javascript:alert(1)"],
    ["localhost", "http://localhost/craft/auth/callback"],
    ["127.0.0.1", "http://127.0.0.1/craft/auth/callback"],
    ["empty", ""]
  ])("rejects %s", (_name, candidate) => {
    expect(redirectUriMatches(REGISTERED, candidate)).toBe(false);
  });

  it.each([undefined, null, 42, {}, [REGISTERED[0]]])("rejects non-string %p", (value) => {
    expect(redirectUriMatches(REGISTERED, value)).toBe(false);
  });

  it("does not treat a registered localhost URI loosely", () => {
    const registered = ["http://localhost:3000/cb"];
    expect(redirectUriMatches(registered, "http://localhost:3000/cb")).toBe(true);
    expect(redirectUriMatches(registered, "http://localhost:3001/cb")).toBe(false);
    expect(redirectUriMatches(registered, "http://127.0.0.1:3000/cb")).toBe(false);
    expect(redirectUriMatches(registered, "http://localhost:3000/cb/")).toBe(false);
  });
});

describe("redirect URI registration rules", () => {
  const origins = ["https://site.example"];
  it("accepts a clean https URI whose origin is allowed", () => {
    expect(checkRedirectUriForRegistration("https://site.example/craft/auth/callback", origins, true)).toEqual({ ok: true });
  });
  it.each([
    ["http://site.example/cb", "insecure"],
    ["https://site.example/cb#frag", "fragment"],
    ["https://u:p@site.example/cb", "userinfo"],
    ["https://*.site.example/cb", "malformed"],
    ["https://other.example/cb", "origin_not_allowed"],
    ["not a url", "malformed"],
    ["", "malformed"]
  ])("rejects %s (%s)", (uri, reason) => {
    expect(checkRedirectUriForRegistration(uri, origins, true)).toEqual({ ok: false, reason });
  });
  it("allows loopback http only outside production", () => {
    const local = ["http://localhost:3000"];
    expect(checkRedirectUriForRegistration("http://localhost:3000/cb", local, false)).toEqual({ ok: true });
    expect(checkRedirectUriForRegistration("http://localhost:3000/cb", local, true)).toEqual({ ok: false, reason: "insecure" });
  });
  it("the operator script applies the same rules", () => {
    expect(scriptCheck("https://site.example/cb", true)).toBeNull();
    for (const bad of ["http://site.example/cb", "https://site.example/cb#x", "https://u@site.example/cb", "https://*.site.example/cb"]) {
      expect(scriptCheck(bad, true)).not.toBeNull();
    }
    expect(scriptCheck("http://localhost:3000/cb", false)).toBeNull();
    expect(scriptCheck("http://localhost:3000/cb", true)).not.toBeNull();
  });
});

describe("client secrets", () => {
  it("hashes with a per-secret salt and never stores the secret", () => {
    const a = hashClientSecret(CLIENT_SECRET);
    const b = hashClientSecret(CLIENT_SECRET);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(a).not.toContain(CLIENT_SECRET);
  });

  it("verifies the right secret and rejects wrong, empty, truncated and padded ones", () => {
    const stored = hashClientSecret(CLIENT_SECRET);
    expect(verifyClientSecret(CLIENT_SECRET, stored)).toBe(true);
    for (const bad of ["", "wrong", CLIENT_SECRET.slice(0, -1), `${CLIENT_SECRET} `, CLIENT_SECRET.toUpperCase(), `${CLIENT_SECRET}x`]) {
      expect(verifyClientSecret(bad, stored)).toBe(false);
    }
  });

  it.each([null, undefined, "", "plain", "v1$only", "v2$a$b", "v1$$", "v1$AAAA$AAAA", "v1$a$b$c"])("never verifies against malformed stored value %p", (stored) => {
    expect(verifyClientSecret(CLIENT_SECRET, stored as string | null)).toBe(false);
    expect(verifyClientSecret("", stored as string | null)).toBe(false);
  });

  it("uses a constant-time comparison primitive", async () => {
    const source = (await import("node:fs")).readFileSync(new URL("./clients.ts", import.meta.url), "utf8");
    expect(source).toContain("timingSafeEqual");
    expect(source).not.toMatch(/secret\s*===|===\s*secret/);
  });

  it("generates high-entropy identifiers", () => {
    expect(generateClientId()).toMatch(/^jc_[A-Za-z0-9_-]{22}$/);
    expect(isClientIdShape(generateClientId())).toBe(true);
    expect(generateClientSecret()).toMatch(/^jcs_[A-Za-z0-9_-]{43}$/);
    expect(generateClientSecret()).not.toBe(generateClientSecret());
  });

  it("the operator script writes a hash the server verifies", () => {
    expect(verifyClientSecret(CLIENT_SECRET, scriptHash(CLIENT_SECRET))).toBe(true);
    expect(verifyClientSecret("nope", scriptHash(CLIENT_SECRET))).toBe(false);
  });

  describe("rotation overlap", () => {
    const NOW = new Date("2026-11-06T12:00:00Z");
    const OLD = "jcs_old-secret-value";
    const rotated = (expiresAt: Date | null) => makeClient({ previousSecretHash: hashClientSecret(OLD), previousSecretExpiresAt: expiresAt });
    it("accepts the new secret and, until it expires, the previous one", () => {
      const client = rotated(new Date(NOW.getTime() + 3600_000));
      expect(authenticateClientSecret(client, CLIENT_SECRET, NOW)).toBe(true);
      expect(authenticateClientSecret(client, OLD, NOW)).toBe(true);
    });
    it("rejects the previous secret once the window closes or is unset", () => {
      expect(authenticateClientSecret(rotated(new Date(NOW.getTime() - 1)), OLD, NOW)).toBe(false);
      expect(authenticateClientSecret(rotated(NOW), OLD, NOW)).toBe(false);
      expect(authenticateClientSecret(rotated(null), OLD, NOW)).toBe(false);
      expect(authenticateClientSecret(makeClient(), OLD, NOW)).toBe(false);
    });
  });
});

describe("client lookup", () => {
  it("returns active clients only and treats malformed ids as unknown", async () => {
    const db = new FakeOidcDb();
    db.clients.push(makeClient());
    expect((await findActiveClient(db, CLIENT_ID))?.clientId).toBe(CLIENT_ID);
    expect(await findActiveClient(db, "jc_unknown")).toBeNull();
    expect(await findActiveClient(db, undefined)).toBeNull();
    expect(await findActiveClient(db, { clientId: CLIENT_ID })).toBeNull();
    db.clients[0].status = "disabled";
    expect(await findActiveClient(db, CLIENT_ID)).toBeNull();
  });
});
