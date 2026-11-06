import { generateKeyPairSync } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair, calculateJwkThumbprint } from "jose";
import { describe, expect, it } from "vitest";
import { OidcKeyError, loadOidcKeys, publicJwks } from "./keys";
import { signIdToken, verifyIdToken, type IdTokenInput } from "./tokens";
import { newSigningKeyJwk, newSigningKeyPem, testConfig } from "./testing";

const ISSUER = "https://jongo.example";
const NOW = new Date("2026-11-06T12:00:00Z");
const input = (over: Partial<IdTokenInput> = {}): IdTokenInput => ({
  issuer: ISSUER, clientId: "jc_AAAAAAAAAAAAAAAAAAAAAA", subject: "20000000-0000-4000-8000-000000000003", nonce: "n-123",
  authTime: new Date(NOW.getTime() - 30_000), scopes: ["openid", "email", "profile"], email: "ed@example.com", emailVerified: true,
  name: "Ed Itor", craft: { dataset: "production", role: "editor", siteId: "20000000-0000-4000-8000-000000000002", via: "site_grant" },
  now: NOW, ...over
});
const verifyOpts = (jwks: { keys: any[] }, over: Record<string, unknown> = {}) =>
  ({ issuer: ISSUER, audience: "jc_AAAAAAAAAAAAAAAAAAAAAA", nonce: "n-123", jwks, now: NOW, ...over });

describe("oidc keys", () => {
  it("loads a JWK, derives an RFC 7638 kid and publishes public parameters only", async () => {
    const keys = await loadOidcKeys(testConfig());
    const jwks = publicJwks(keys);
    expect(jwks.keys).toHaveLength(1);
    const key = jwks.keys[0] as Record<string, unknown>;
    expect(Object.keys(key).sort()).toEqual(["alg", "crv", "kid", "kty", "use", "x"]);
    expect(key).not.toHaveProperty("d");
    expect(key.kid).toBe(await calculateJwkThumbprint({ kty: "OKP", crv: "Ed25519", x: key.x as string }, "sha256"));
    expect(JSON.stringify(jwks)).not.toMatch(/"d"/);
  });

  it("loads a PKCS#8 PEM key too", async () => {
    const keys = await loadOidcKeys(testConfig({ signingKey: newSigningKeyPem() }));
    expect(keys.publicKeys[0].crv).toBe("Ed25519");
  });

  it.each([
    ["garbage", "not a key"],
    ["rsa pem", generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString()],
    ["public-only jwk", JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" })],
    ["x25519 jwk", JSON.stringify(generateKeyPairSync("x25519").privateKey.export({ format: "jwk" }))]
  ])("rejects %s without echoing key material", async (_name, signingKey) => {
    const error = await loadOidcKeys(testConfig({ signingKey })).catch((e) => e);
    expect(error).toBeInstanceOf(OidcKeyError);
    expect(error.message).toContain("JONGO_OIDC_SIGNING_KEY");
    expect(error.message).not.toContain(signingKey.slice(0, 20));
  });

  it("publishes retired public keys after the current one", async () => {
    const old = (generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }) as { x: string });
    const keys = await loadOidcKeys(testConfig({ previousPublicKeys: JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", x: old.x, extra: "ignored" }] }) }));
    expect(keys.publicKeys).toHaveLength(2);
    expect(keys.publicKeys[1].x).toBe(old.x);
    expect(keys.publicKeys[1].kid).not.toBe(keys.kid);
    expect(JSON.stringify(publicJwks(keys))).not.toContain("extra");
  });

  it("refuses retired keys that carry private material", async () => {
    const priv = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
    const error = await loadOidcKeys(testConfig({ previousPublicKeys: JSON.stringify([priv]) })).catch((e) => e);
    expect(error).toBeInstanceOf(OidcKeyError);
    expect(error.message).toContain("JONGO_OIDC_PREVIOUS_PUBLIC_KEYS");
    expect(error.message).not.toContain(String((priv as { d: string }).d));
  });

  it.each(["{not json", "42", JSON.stringify([{ kty: "RSA" }])])("rejects malformed previous keys %s", async (previousPublicKeys) => {
    await expect(loadOidcKeys(testConfig({ previousPublicKeys }))).rejects.toBeInstanceOf(OidcKeyError);
  });
});

describe("ID token signing and verification", () => {
  it("roundtrips with the documented claims", async () => {
    const keys = await loadOidcKeys(testConfig());
    const token = await signIdToken(keys, input());
    const payload = await verifyIdToken(token, verifyOpts(publicJwks(keys)));
    expect(payload).toMatchObject({
      iss: ISSUER, sub: "20000000-0000-4000-8000-000000000003", aud: "jc_AAAAAAAAAAAAAAAAAAAAAA", nonce: "n-123",
      email: "ed@example.com", email_verified: true, name: "Ed Itor",
      craft: { dataset: "production", role: "editor", siteId: "20000000-0000-4000-8000-000000000002", via: "site_grant" }
    });
    expect(payload.exp! - payload.iat!).toBe(300);
    expect(payload.auth_time).toBe(Math.floor(NOW.getTime() / 1000) - 30);
    expect(typeof payload.jti).toBe("string");
    const header = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
    expect(header).toEqual({ alg: "EdDSA", kid: keys.kid, typ: "JWT" });
  });

  it("omits email and name when their scopes were not granted but always carries craft", async () => {
    const keys = await loadOidcKeys(testConfig());
    const payload = await verifyIdToken(await signIdToken(keys, input({ scopes: ["openid"] })), verifyOpts(publicJwks(keys)));
    expect(payload).not.toHaveProperty("email");
    expect(payload).not.toHaveProperty("name");
    expect(payload.craft).toBeDefined();
  });

  it("carries craft.via platform_admin unchanged", async () => {
    const keys = await loadOidcKeys(testConfig());
    const payload = await verifyIdToken(await signIdToken(keys, input({ craft: { dataset: "production", role: "admin", via: "platform_admin" } })), verifyOpts(publicJwks(keys)));
    expect((payload.craft as { via: string }).via).toBe("platform_admin");
  });

  it("verifies with a retired key still in the JWKS after rotation", async () => {
    const oldCfg = testConfig();
    const oldKeys = await loadOidcKeys(oldCfg);
    const token = await signIdToken(oldKeys, input());
    const newKeys = await loadOidcKeys(testConfig({ previousPublicKeys: JSON.stringify([{ kty: "OKP", crv: "Ed25519", x: oldKeys.publicKeys[0].x }]) }));
    await expect(verifyIdToken(token, verifyOpts(publicJwks(newKeys)))).resolves.toBeDefined();
  });

  it("rejects alg none", async () => {
    const keys = await loadOidcKeys(testConfig());
    const body = Buffer.from(JSON.stringify({ iss: ISSUER, sub: "x", aud: "jc_AAAAAAAAAAAAAAAAAAAAAA", exp: 4102444800, iat: 1, nonce: "n-123" })).toString("base64url");
    for (const header of [{ alg: "none", kid: keys.kid }, { alg: "None", kid: keys.kid }]) {
      const token = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${body}.`;
      await expect(verifyIdToken(token, verifyOpts(publicJwks(keys)))).rejects.toThrow();
    }
  });

  it("rejects RS256 and HS256 tokens even when the kid matches", async () => {
    const keys = await loadOidcKeys(testConfig());
    const rsa = await generateKeyPair("RS256", { extractable: true });
    const rs = await new SignJWT({ nonce: "n-123" }).setProtectedHeader({ alg: "RS256", kid: keys.kid }).setIssuer(ISSUER).setSubject("s")
      .setAudience("jc_AAAAAAAAAAAAAAAAAAAAAA").setIssuedAt(Math.floor(NOW.getTime() / 1000)).setExpirationTime(Math.floor(NOW.getTime() / 1000) + 300).sign(rsa.privateKey);
    await expect(verifyIdToken(rs, verifyOpts(publicJwks(keys)))).rejects.toThrow();
    // Classic confusion attack: HMAC keyed with the public key bytes.
    const hs = await new SignJWT({ nonce: "n-123" }).setProtectedHeader({ alg: "HS256", kid: keys.kid }).setIssuer(ISSUER).setSubject("s")
      .setAudience("jc_AAAAAAAAAAAAAAAAAAAAAA").setIssuedAt(Math.floor(NOW.getTime() / 1000)).setExpirationTime(Math.floor(NOW.getTime() / 1000) + 300)
      .sign(Buffer.from(keys.publicKeys[0].x, "base64url"));
    await expect(verifyIdToken(hs, verifyOpts(publicJwks(keys)))).rejects.toThrow();
    // An RSA key offered in the JWKS is not accepted for EdDSA verification either.
    const rsaJwk = { ...(await exportJWK(rsa.publicKey)), kid: "rsa-kid" };
    await expect(verifyIdToken(rs, verifyOpts({ keys: [rsaJwk] }))).rejects.toThrow();
  });

  it("rejects a token signed by an unknown key, an unknown kid and a tampered payload", async () => {
    const keys = await loadOidcKeys(testConfig());
    const other = await loadOidcKeys(testConfig());
    const token = await signIdToken(other, input());
    await expect(verifyIdToken(token, verifyOpts(publicJwks(keys)))).rejects.toThrow();
    const good = await signIdToken(keys, input());
    const [h, p, s] = good.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), craft: { role: "admin" } })).toString("base64url");
    await expect(verifyIdToken(`${h}.${forged}.${s}`, verifyOpts(publicJwks(keys)))).rejects.toThrow();
  });

  it("rejects expired tokens, tokens from the future, and enforces the lifetime", async () => {
    const keys = await loadOidcKeys(testConfig());
    const token = await signIdToken(keys, input());
    const jwks = publicJwks(keys);
    await expect(verifyIdToken(token, verifyOpts(jwks, { now: new Date(NOW.getTime() + 301_000 + 61_000) }))).rejects.toThrow();
    await expect(verifyIdToken(token, verifyOpts(jwks, { now: new Date(NOW.getTime() + 299_000) }))).resolves.toBeDefined();
    // Verifier clock behind the issuer by more than the tolerance: iat/nbf look like the future.
    await expect(verifyIdToken(token, verifyOpts(jwks, { now: new Date(NOW.getTime() - 120_000) }))).rejects.toThrow();
  });

  it.each([
    ["issuer", { issuer: "https://evil.example" }],
    ["audience", { audience: "jc_BBBBBBBBBBBBBBBBBBBBBB" }],
    ["nonce", { nonce: "other" }]
  ])("rejects the wrong %s", async (_name, override) => {
    const keys = await loadOidcKeys(testConfig());
    const token = await signIdToken(keys, input());
    await expect(verifyIdToken(token, verifyOpts(publicJwks(keys), override))).rejects.toThrow();
  });
});

describe("key generator script", () => {
  it("produces a key the server loads, with the same RFC 7638 kid and a public JWK without d", async () => {
    const { generateSigningKey } = await import("../../../../../scripts/oidc-generate-key.mjs" as string);
    const generated = generateSigningKey() as { privateJwk: { d: string }; publicJwk: Record<string, string>; kid: string };
    const keys = await loadOidcKeys(testConfig({ signingKey: JSON.stringify(generated.privateJwk) }));
    expect(keys.kid).toBe(generated.kid);
    expect(generated.publicJwk).not.toHaveProperty("d");
    expect(JSON.stringify(publicJwks(keys))).not.toContain(generated.privateJwk.d);
    expect(newSigningKeyJwk()).not.toBe(newSigningKeyJwk());
  });
});
