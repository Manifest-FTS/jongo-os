import { describe, expect, it } from "vitest";
import { ID_TOKEN_TTL_SECONDS, isOidcEnabled, normalizeIssuer, readOidcConfig } from "./config";

describe("feature flag", () => {
  it("is on only for the exact string true", () => {
    expect(isOidcEnabled({ JONGO_OIDC_ENABLED: "true" })).toBe(true);
    for (const value of [undefined, "", "TRUE", "True", "1", "yes", " true", "true ", "false", "on"]) {
      expect(isOidcEnabled({ JONGO_OIDC_ENABLED: value })).toBe(false);
    }
  });
});

describe("configuration", () => {
  const key = '{"kty":"OKP","crv":"Ed25519","d":"SECRET-VALUE","x":"x"}';

  it("fails closed naming variables only, never values", () => {
    const result = readOidcConfig({ JONGO_OIDC_ENABLED: "true", JONGO_OIDC_SIGNING_KEY: "", JONGO_OIDC_ISSUER: "ftp://jongo.app" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toEqual(["JONGO_OIDC_ISSUER: invalid", "JONGO_OIDC_SIGNING_KEY: missing"]);
      expect(JSON.stringify(result.problems)).not.toContain("ftp://");
    }
  });

  it("accepts a valid configuration and normalizes the issuer to an origin", () => {
    const result = readOidcConfig({ JONGO_OIDC_ISSUER: "https://jongo.app/", JONGO_OIDC_SIGNING_KEY: key, JONGO_OIDC_PREVIOUS_PUBLIC_KEYS: " [] " });
    expect(result).toEqual({ ok: true, config: { issuer: "https://jongo.app", signingKey: key, previousPublicKeys: "[]" } });
  });

  it.each([
    "https://jongo.app/path", "https://jongo.app/?q=1", "https://jongo.app/#f", "https://user:pw@jongo.app", "http://jongo.app", "jongo.app", "javascript:alert(1)"
  ])("rejects issuer %s", (issuer) => {
    expect(normalizeIssuer(issuer, true)).toBeNull();
  });

  it("allows http only for loopback outside production", () => {
    expect(normalizeIssuer("http://localhost:3000", false)).toBe("http://localhost:3000");
    expect(normalizeIssuer("http://localhost:3000", true)).toBeNull();
    expect(normalizeIssuer("http://evil.example", false)).toBeNull();
  });

  it("refuses to run in production with a missing or default NEXTAUTH_SECRET", () => {
    const base = { JONGO_OIDC_ISSUER: "https://jongo.app", JONGO_OIDC_SIGNING_KEY: key, NODE_ENV: "production" };
    expect(readOidcConfig({ ...base })).toMatchObject({ ok: false, problems: ["NEXTAUTH_SECRET: missing or default in production"] });
    expect(readOidcConfig({ ...base, NEXTAUTH_SECRET: "dev-secret-change-in-production" }).ok).toBe(false);
    expect(readOidcConfig({ ...base, NEXTAUTH_SECRET: "a-real-secret" }).ok).toBe(true);
    expect(readOidcConfig({ JONGO_OIDC_ISSUER: "https://jongo.app", JONGO_OIDC_SIGNING_KEY: key, NODE_ENV: "development" }).ok).toBe(true);
  });

  it("keeps the documented lifetimes", () => {
    expect(ID_TOKEN_TTL_SECONDS).toBe(300);
  });
});
