import { describe, expect, it } from "vitest";
import { generateAuthCode, hashAuthCode, issueAuthCode, redeemAuthCode } from "./codes";
import { s256Challenge } from "./pkce";
import { FakeOidcDb, ids, REDIRECT_URI } from "./testing";

const verifier = "v".repeat(64);
const challenge = s256Challenge(verifier);
const T0 = new Date("2026-11-06T12:00:00Z");

async function setup(over: Record<string, unknown> = {}) {
  const db = new FakeOidcDb();
  const issued = await issueAuthCode(db, {
    oidcClientId: ids.client, userId: ids.user, redirectUri: REDIRECT_URI, codeChallenge: challenge, nonce: "n", scope: "openid email",
    authTime: T0, now: T0, ...over
  });
  return { db, ...issued };
}
const redeem = (db: FakeOidcDb, code: string, over: Record<string, unknown> = {}) =>
  redeemAuthCode(db, { code, oidcClientId: ids.client, redirectUri: REDIRECT_URI, codeVerifier: verifier, now: new Date(T0.getTime() + 5_000), ...over });

describe("authorization codes", () => {
  it("issues 256-bit random codes and stores only their SHA-256", async () => {
    const { db, code, expiresAt } = await setup();
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateAuthCode()).not.toBe(generateAuthCode());
    expect(db.codes).toHaveLength(1);
    expect(db.codes[0].codeHash).toBe(hashAuthCode(code));
    expect(db.codes[0].codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(db.codes)).not.toContain(code);
    expect(expiresAt.getTime() - T0.getTime()).toBe(60_000);
  });

  it("redeems once with the bound client, redirect URI and PKCE verifier", async () => {
    const { db, code } = await setup();
    const first = await redeem(db, code);
    expect(first).toEqual({ ok: true, userId: ids.user, scope: "openid email", nonce: "n", authTime: T0 });
    expect(await redeem(db, code)).toMatchObject({ ok: false, reason: "replay" });
  });

  it("is single use even under concurrent redemption", async () => {
    const { db, code } = await setup();
    db.tick = () => new Promise((resolve) => setTimeout(resolve, 5));
    const results = await Promise.all(Array.from({ length: 8 }, () => redeem(db, code)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === "replay")).toHaveLength(7);
  });

  it("expires after 60 seconds", async () => {
    const { db, code } = await setup();
    expect(await redeem(db, code, { now: new Date(T0.getTime() + 60_000) })).toMatchObject({ ok: false, reason: "expired" });
  });

  it("is still valid just before expiry", async () => {
    const { db, code } = await setup();
    expect((await redeem(db, code, { now: new Date(T0.getTime() + 59_999) })).ok).toBe(true);
  });

  it("rejects unknown and malformed codes", async () => {
    const { db } = await setup();
    expect(await redeem(db, generateAuthCode())).toMatchObject({ ok: false, reason: "unknown" });
    for (const bad of ["", "short", "a".repeat(44), `${"a".repeat(42)}!`]) {
      expect(await redeem(db, bad)).toMatchObject({ ok: false, reason: "unknown" });
    }
  });

  it("rejects replay by a different client and burns the code", async () => {
    const { db, code } = await setup();
    expect(await redeem(db, code, { oidcClientId: "20000000-0000-4000-8000-0000000000ff" })).toMatchObject({ ok: false, reason: "client_mismatch" });
    expect(await redeem(db, code)).toMatchObject({ ok: false, reason: "replay" });
  });

  it.each([
    ["trailing slash", `${REDIRECT_URI}/`],
    ["different host", "https://evil.example/craft/auth/callback"],
    ["case change", REDIRECT_URI.toUpperCase()],
    ["added query", `${REDIRECT_URI}?x=1`]
  ])("rejects a different redirect_uri (%s) and burns the code", async (_name, redirectUri) => {
    const { db, code } = await setup();
    expect(await redeem(db, code, { redirectUri })).toMatchObject({ ok: false, reason: "redirect_mismatch" });
    expect(await redeem(db, code)).toMatchObject({ ok: false, reason: "replay" });
  });

  it("rejects a wrong or missing PKCE verifier and burns the code", async () => {
    const { db, code } = await setup();
    expect(await redeem(db, code, { codeVerifier: "w".repeat(64) })).toMatchObject({ ok: false, reason: "pkce_failed" });
    expect(await redeem(db, code)).toMatchObject({ ok: false, reason: "replay" });
    const second = await setup();
    expect(await redeem(second.db, second.code, { codeVerifier: "" })).toMatchObject({ ok: false, reason: "pkce_failed" });
  });

  it("cleans up long-expired codes when issuing", async () => {
    const db = new FakeOidcDb();
    await issueAuthCode(db, { oidcClientId: ids.client, userId: ids.user, redirectUri: REDIRECT_URI, codeChallenge: challenge, nonce: "n", scope: "openid", authTime: T0, now: T0 });
    await issueAuthCode(db, { oidcClientId: ids.client, userId: ids.user, redirectUri: REDIRECT_URI, codeChallenge: challenge, nonce: "n", scope: "openid", authTime: T0, now: new Date(T0.getTime() + 2 * 3600_000) });
    expect(db.codes).toHaveLength(1);
  });
});
