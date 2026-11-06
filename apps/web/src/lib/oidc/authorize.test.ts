import { beforeEach, describe, expect, it, vi } from "vitest";
import { processAuthorize, processConsent, validateAuthorizeRequest, type AuthorizeDeps, type RawParams } from "./authorize";
import { redeemAuthCode } from "./codes";
import { s256Challenge } from "./pkce";
import { CLIENT_ID, FakeOidcDb, REDIRECT_URI, ids, makeClient } from "./testing";
import type { CraftAccessResult } from "@/lib/craft-access";

const verifier = "v".repeat(64);
const challenge = s256Challenge(verifier);
const ISSUER = "https://jongo.example";
const NOW = new Date("2026-11-06T12:00:00Z");
const SECRET = Buffer.alloc(32, 7);

const valid = (over: RawParams = {}): RawParams => ({
  client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code", scope: "openid email profile",
  state: "state-123", nonce: "nonce-123", code_challenge: challenge, code_challenge_method: "S256", ...over
});
const access = (over: Partial<CraftAccessResult> = {}): CraftAccessResult => ({
  role: "editor", via: "site_grant", capped: false, siteId: ids.site, organizationId: ids.org,
  user: { id: ids.user, email: "ed@example.com", emailVerified: true, name: "Ed" }, ...over
});

let db: FakeOidcDb;
let resolveAccess: ReturnType<typeof vi.fn>;
const deps = (): AuthorizeDeps => ({ db: db as never, resolveAccess: resolveAccess as never, consentSecret: SECRET, issuer: ISSUER, now: NOW });

beforeEach(() => {
  db = new FakeOidcDb();
  db.clients.push(makeClient());
  resolveAccess = vi.fn().mockResolvedValue(access());
});

describe("authorization request validation", () => {
  it("accepts a valid request", async () => {
    const out = await validateAuthorizeRequest(db as never, valid());
    expect(out).toMatchObject({ kind: "ok", request: { state: "state-123", nonce: "nonce-123", scopes: ["openid", "email", "profile"] } });
  });

  it.each([
    ["unknown client", { client_id: "jc_BBBBBBBBBBBBBBBBBBBBBB" }],
    ["missing client", { client_id: undefined }],
    ["malformed client", { client_id: "x" }],
    ["repeated client_id", { client_id: [CLIENT_ID, CLIENT_ID] }]
  ])("renders an error page, never a redirect, for %s", async (_n, over) => {
    expect(await validateAuthorizeRequest(db as never, valid(over as RawParams))).toMatchObject({ kind: "error_page", error: "invalid_client" });
  });

  it("renders an error page for a disabled client", async () => {
    db.clients[0].status = "disabled";
    expect(await validateAuthorizeRequest(db as never, valid())).toMatchObject({ kind: "error_page" });
  });

  it.each([
    ["trailing slash", `${REDIRECT_URI}/`],
    ["other host", "https://evil.example/craft/auth/callback"],
    ["missing", undefined],
    ["repeated", [REDIRECT_URI, "https://evil.example"]],
    ["open redirect via userinfo", "https://site.example@evil.example/craft/auth/callback"]
  ])("renders an error page, never a redirect, for redirect_uri %s", async (_n, uri) => {
    const out = await validateAuthorizeRequest(db as never, valid({ redirect_uri: uri as string }));
    expect(out).toMatchObject({ kind: "error_page", error: "invalid_redirect_uri" });
    expect(out).not.toHaveProperty("redirectUri");
  });

  it.each([
    ["wrong response_type", { response_type: "token" }, "unsupported_response_type"],
    ["implicit id_token", { response_type: "id_token" }, "unsupported_response_type"],
    ["hybrid", { response_type: "code id_token" }, "unsupported_response_type"],
    ["missing response_type", { response_type: undefined }, "unsupported_response_type"],
    ["missing state", { state: undefined }, "invalid_request"],
    ["empty state", { state: "" }, "invalid_request"],
    ["missing nonce", { nonce: undefined }, "invalid_request"],
    ["missing challenge", { code_challenge: undefined }, "invalid_request"],
    ["plain method", { code_challenge_method: "plain" }, "invalid_request"],
    ["missing method (defaults to plain in RFC)", { code_challenge_method: undefined }, "invalid_request"],
    ["lowercase s256", { code_challenge_method: "s256" }, "invalid_request"],
    ["short challenge", { code_challenge: "abc" }, "invalid_request"],
    ["missing scope", { scope: undefined }, "invalid_scope"],
    ["no openid", { scope: "email profile" }, "invalid_scope"],
    ["unknown scope", { scope: "openid offline_access" }, "invalid_scope"],
    ["prompt none", { prompt: "none" }, "invalid_request"],
    ["response_mode fragment", { response_mode: "fragment" }, "invalid_request"],
    ["request object", { request: "eyJ..." }, "request_not_supported"],
    ["request_uri", { request_uri: "https://evil.example/r" }, "request_uri_not_supported"],
    ["repeated nonce", { nonce: ["a", "b"] }, "invalid_request"]
  ])("redirects %s to the REGISTERED redirect_uri with an OAuth error", async (_n, over, error) => {
    const out = await validateAuthorizeRequest(db as never, valid(over as RawParams));
    expect(out).toMatchObject({ kind: "redirect_error", redirectUri: REDIRECT_URI, error });
  });

  it("echoes state in errors only when it is sane", async () => {
    expect(await validateAuthorizeRequest(db as never, valid({ response_type: "token" }))).toMatchObject({ state: "state-123" });
    expect(await validateAuthorizeRequest(db as never, valid({ response_type: "token", state: "has space" }))).toMatchObject({ state: undefined });
    expect(await validateAuthorizeRequest(db as never, valid({ response_type: "token", state: "x".repeat(513) }))).toMatchObject({ state: undefined });
  });

  it("accepts the optional craft scope and de-duplicates", async () => {
    const out = await validateAuthorizeRequest(db as never, valid({ scope: "openid craft openid" }));
    expect(out).toMatchObject({ kind: "ok", request: { scopes: ["openid", "craft"] } });
  });
});

describe("authorize flow", () => {
  it("shows consent the first time, with who/what/role, and issues nothing yet", async () => {
    const out = await processAuthorize(deps(), ids.user, valid());
    expect(out.kind).toBe("consent");
    if (out.kind !== "consent") return;
    expect(out.view).toMatchObject({ siteName: "Golf Lab Craft", datasetName: "production", email: "ed@example.com", name: "Ed", role: "editor", via: "site_grant" });
    expect(out.view.fields).toMatchObject({ client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, state: "state-123", code_challenge: challenge });
    expect(db.codes).toHaveLength(0);
    expect(db.audits).toHaveLength(0);
  });

  it("denies with no_access (rendered, not redirected) when the user has no Craft role", async () => {
    resolveAccess.mockResolvedValue(null);
    expect(await processAuthorize(deps(), ids.user, valid())).toEqual({ kind: "no_access", clientName: "Golf Lab Craft" });
    expect(db.codes).toHaveLength(0);
  });

  it("resolves access for the client's own site only, never a site named in the request", async () => {
    await processAuthorize(deps(), ids.user, valid({ site_id: "other", siteId: "other" }));
    expect(resolveAccess).toHaveBeenCalledWith(ids.user, ids.site);
  });

  it("issues a code and redirects with code, state and iss once consent exists", async () => {
    await processConsent(deps(), ids.user, valid(), "allow", (await getToken()));
    resolveAccess.mockClear();
    const out = await processAuthorize(deps(), ids.user, valid());
    expect(out.kind).toBe("redirect");
    if (out.kind !== "redirect") return;
    const url = new URL(out.location);
    expect(`${url.origin}${url.pathname}`).toBe(REDIRECT_URI);
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("iss")).toBe(ISSUER);
    const code = url.searchParams.get("code")!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await redeemAuthCode(db as never, { code, oidcClientId: ids.client, redirectUri: REDIRECT_URI, codeVerifier: verifier, now: NOW }))
      .toMatchObject({ ok: true, userId: ids.user, nonce: "nonce-123", scope: "openid email profile" });
  });

  it("asks again when a broader scope than the recorded consent is requested", async () => {
    await processConsent(deps(), ids.user, valid({ scope: "openid" }), "allow", await getToken({ scope: "openid" }));
    expect((await processAuthorize(deps(), ids.user, valid({ scope: "openid" }))).kind).toBe("redirect");
    expect((await processAuthorize(deps(), ids.user, valid({ scope: "openid email" }))).kind).toBe("consent");
  });

  it("protocol errors redirect back to the registered URI with state and iss", async () => {
    const out = await processAuthorize(deps(), ids.user, valid({ code_challenge_method: "plain" }));
    expect(out.kind).toBe("redirect");
    if (out.kind !== "redirect") return;
    const url = new URL(out.location);
    expect(url.searchParams.get("error")).toBe("invalid_request");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("code")).toBeNull();
    expect(url.origin).toBe("https://site.example");
  });

  it("never redirects when the redirect_uri is not the registered one", async () => {
    const out = await processAuthorize(deps(), ids.user, valid({ redirect_uri: "https://evil.example/cb" }));
    expect(out.kind).toBe("error_page");
  });

  async function getToken(over: RawParams = {}) {
    const out = await processAuthorize(deps(), ids.user, valid(over));
    if (out.kind !== "consent") throw new Error(`expected consent, got ${out.kind}`);
    return out.view.consentToken;
  }
});

describe("consent submission", () => {
  async function token(over: RawParams = {}, userId = ids.user) {
    const out = await processAuthorize(deps(), userId, valid(over));
    if (out.kind !== "consent") throw new Error(out.kind);
    return out.view.consentToken;
  }

  it("on Allow records consent, audits, and issues a code", async () => {
    const out = await processConsent(deps(), ids.user, valid(), "allow", await token());
    expect(out.kind).toBe("redirect");
    expect(db.consents).toHaveLength(1);
    expect(db.consents[0]).toMatchObject({ userId: ids.user, oidcClientId: ids.client, scope: "openid email profile" });
    expect(db.audits.map((a) => a.action)).toEqual(["oidc.consent.grant", "oidc.code.issue"]);
    expect(JSON.stringify(db.audits)).not.toMatch(/[A-Za-z0-9_-]{43}/);
    expect(db.codes).toHaveLength(1);
  });

  it("on Cancel redirects access_denied and records nothing", async () => {
    const out = await processConsent(deps(), ids.user, valid(), "deny", await token());
    expect(out.kind).toBe("redirect");
    if (out.kind === "redirect") expect(new URL(out.location).searchParams.get("error")).toBe("access_denied");
    expect(db.consents).toHaveLength(0);
    expect(db.codes).toHaveLength(0);
  });

  it("rejects a missing, malformed, expired, foreign-user or request-mismatched consent token", async () => {
    const good = await token();
    for (const bad of [undefined, "", "garbage", "1.2.3", good.replace(/.$/, "A"), `${Number(good.split(".")[0]) + 100}.${good.split(".")[1]}`]) {
      expect(await processConsent(deps(), ids.user, valid(), "allow", bad)).toMatchObject({ kind: "error_page", error: "invalid_request" });
    }
    // Another user cannot replay this user's token.
    expect(await processConsent(deps(), "20000000-0000-4000-8000-0000000000aa", valid(), "allow", good)).toMatchObject({ kind: "error_page" });
    // A tampered request (state, nonce, challenge, scope) no longer matches.
    for (const over of [{ state: "other" }, { nonce: "other" }, { code_challenge: s256Challenge("z".repeat(64)) }, { scope: "openid" }]) {
      expect(await processConsent(deps(), ids.user, valid(over), "allow", good)).toMatchObject({ kind: "error_page" });
    }
    // An expired token (issued 11 minutes ago).
    const old = await (async () => {
      const out = await processAuthorize({ ...deps(), now: new Date(NOW.getTime() - 11 * 60_000) }, ids.user, valid());
      return out.kind === "consent" ? out.view.consentToken : "";
    })();
    expect(await processConsent(deps(), ids.user, valid(), "allow", old)).toMatchObject({ kind: "error_page" });
    expect(db.codes).toHaveLength(0);
  });

  it("re-validates the request: a tampered redirect_uri is never redirected to", async () => {
    const good = await token();
    const out = await processConsent(deps(), ids.user, valid({ redirect_uri: "https://evil.example/cb" }), "allow", good);
    expect(out.kind).toBe("error_page");
  });

  it("re-checks access when Allow is pressed", async () => {
    const good = await token();
    resolveAccess.mockResolvedValue(null);
    expect((await processConsent(deps(), ids.user, valid(), "allow", good)).kind).toBe("no_access");
    expect(db.codes).toHaveLength(0);
    expect(db.consents).toHaveLength(0);
  });
});
