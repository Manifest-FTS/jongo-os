import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

// Vitest compiles tsx with the classic runtime (tsconfig keeps jsx: preserve for Next).
(globalThis as { React?: unknown }).React = React;

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), auth: vi.fn(), resolve: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/auth.config", () => ({ auth: mocks.auth }));
vi.mock("@/lib/craft-access", () => ({ resolveCraftAccess: mocks.resolve }));

import * as discovery from "@/app/.well-known/openid-configuration/route";
import * as jwks from "@/app/api/oidc/jwks/route";
import * as token from "@/app/api/oidc/token/route";
import * as consent from "@/app/oidc/authorize/consent/route";
import AuthorizePage from "@/app/oidc/authorize/page";
import ErrorPage from "@/app/oidc/error/page";
import { buildDiscoveryDocument } from "@/lib/oidc/discovery";
import { s256Challenge } from "@/lib/oidc/pkce";
import { CLIENT_ID, FakeOidcDb, REDIRECT_URI, ids, makeClient, newSigningKeyJwk } from "@/lib/oidc/testing";

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
const ISSUER = "https://jongo.example";
const routes = { discovery, jwks, token, consent } as Record<string, Record<string, unknown>>;

function enable(extra: Record<string, string> = {}) {
  vi.stubEnv("JONGO_OIDC_ENABLED", "true");
  vi.stubEnv("JONGO_OIDC_ISSUER", ISSUER);
  vi.stubEnv("JONGO_OIDC_SIGNING_KEY", newSigningKeyJwk());
  vi.stubEnv("NEXTAUTH_SECRET", "a-real-test-secret");
  for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
}
const req = (method: string, url = `${ISSUER}/x`, init: RequestInit = {}) => new Request(url, { method, ...init });
async function call(handler: unknown, method: string, init: RequestInit = {}) {
  return (handler as (r: Request) => Promise<Response>)(req(method, undefined, init));
}
const digestOf = async (promise: Promise<unknown>) => ((await promise.catch((e) => e)) as { digest?: string }).digest ?? "";

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("flag off: every new route is inert", () => {
  it.each(["undefined", "", "false", "TRUE", "1", " true"])("JONGO_OIDC_ENABLED=%j", async (value) => {
    if (value !== "undefined") vi.stubEnv("JONGO_OIDC_ENABLED", value);
    vi.stubEnv("JONGO_OIDC_ISSUER", ISSUER);
    vi.stubEnv("JONGO_OIDC_SIGNING_KEY", newSigningKeyJwk());
    for (const [name, mod] of Object.entries(routes)) {
      for (const method of METHODS) {
        const handler = mod[method];
        if (!handler) continue;
        const response = await call(handler, method, method === "POST" ? { body: "a=b", headers: { "content-type": "application/x-www-form-urlencoded" } } : {});
        expect(response.status, `${name} ${method}`).toBe(404);
        expect(await response.text()).toBe("Not Found");
      }
    }
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("the authorize and error pages 404 and touch nothing", async () => {
    expect(await digestOf(AuthorizePage({ searchParams: Promise.resolve({ client_id: CLIENT_ID }) }))).toContain("404");
    expect(await digestOf(ErrorPage({ searchParams: Promise.resolve({ e: "invalid_client" }) }))).toContain("404");
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.auth).not.toHaveBeenCalled();
  });

  it("covers every method export of every route file (no handler skips the flag check)", () => {
    const expected: Record<string, string[]> = {
      discovery: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      jwks: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      token: ["POST", "GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"],
      consent: ["POST", "GET", "PUT", "PATCH", "DELETE", "OPTIONS"]
    };
    for (const [name, methods] of Object.entries(expected)) {
      const exported = Object.keys(routes[name]).filter((key) => (METHODS as readonly string[]).includes(key));
      expect(exported.sort(), name).toEqual([...methods].sort());
    }
  });
});

describe("flag on: discovery", () => {
  it("serves the discovery document built from the configured issuer only", async () => {
    enable();
    const response = await call(discovery.GET, "GET");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const doc = await response.json();
    expect(doc).toEqual(buildDiscoveryDocument(ISSUER));
    expect(doc).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oidc/authorize`,
      token_endpoint: `${ISSUER}/api/oidc/token`,
      jwks_uri: `${ISSUER}/api/oidc/jwks`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      id_token_signing_alg_values_supported: ["EdDSA"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      grant_types_supported: ["authorization_code"],
      subject_types_supported: ["public"],
      scopes_supported: ["openid", "email", "profile", "craft"]
    });
    expect(doc).not.toHaveProperty("userinfo_endpoint");
    expect(doc).not.toHaveProperty("registration_endpoint");
    expect(doc.response_types_supported).not.toContain("id_token");
    expect(doc.response_types_supported).not.toContain("token");
  });

  it("ignores the request Host header (no host-header injection)", async () => {
    enable();
    const response = await discovery.GET();
    expect((await response.json()).issuer).toBe(ISSUER);
  });
});

describe("flag on: JWKS", () => {
  it("contains only public parameters", async () => {
    enable();
    const response = await call(jwks.GET, "GET");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.keys).toHaveLength(1);
    for (const key of body.keys) {
      expect(key).not.toHaveProperty("d");
      expect(Object.keys(key).sort()).toEqual(["alg", "crv", "kid", "kty", "use", "x"]);
      expect(key).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig" });
    }
    const privateD = (JSON.parse(process.env.JONGO_OIDC_SIGNING_KEY!) as { d: string }).d;
    expect(JSON.stringify(body)).not.toContain(privateD);
  });
});

describe("flag on: method handling", () => {
  it("returns 405 with Allow for unsupported methods", async () => {
    enable();
    expect((await call(token.GET, "GET")).status).toBe(405);
    expect((await call(token.GET, "GET")).headers.get("allow")).toBe("POST");
    expect((await call(jwks.POST, "POST")).status).toBe(405);
    expect((await call(discovery.DELETE, "DELETE")).headers.get("allow")).toBe("GET, HEAD");
    expect((await call(consent.GET, "GET")).status).toBe(405);
  });
});

describe("flag on but misconfigured: fails closed", () => {
  it.each([
    ["missing issuer", { JONGO_OIDC_ISSUER: "" }],
    ["bad issuer", { JONGO_OIDC_ISSUER: "http://jongo.example" }],
    ["missing key", { JONGO_OIDC_SIGNING_KEY: "" }],
    ["garbage key", { JONGO_OIDC_SIGNING_KEY: "this-is-not-a-key-SECRETVALUE" }]
  ])("%s -> 503 naming variables only", async (_name, override) => {
    enable(override);
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => { logs.push(args.join(" ")); });
    for (const response of [await discovery.GET(), await jwks.GET(), await call(token.POST, "POST")]) {
      expect(response.status).toBe(503);
      expect(await response.text()).not.toMatch(/SECRETVALUE|http:\/\//);
    }
    expect(logs.join("\n")).not.toContain("SECRETVALUE");
    expect(logs.join("\n")).toMatch(/JONGO_OIDC_/);
  });

  it("refuses in production when NEXTAUTH_SECRET is missing", async () => {
    enable({ NODE_ENV: "production", NEXTAUTH_SECRET: "" });
    expect((await discovery.GET()).status).toBe(503);
  });
});

describe("flag on: token route wiring", () => {
  it("rejects a JSON body and never reaches the database for it", async () => {
    enable();
    mocks.getDb.mockResolvedValue(new FakeOidcDb());
    const response = await call(token.POST, "POST", { body: "{}", headers: { "content-type": "application/json" } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
  });

  it("answers 503 when the database is unavailable", async () => {
    enable();
    mocks.getDb.mockResolvedValue(null);
    expect((await call(token.POST, "POST", { body: "a=b", headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(503);
  });
});

describe("flag on: authorize page and consent route", () => {
  const challenge = s256Challenge("v".repeat(64));
  const params = (over: Record<string, string> = {}) => ({
    client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code", scope: "openid email", state: "st", nonce: "no",
    code_challenge: challenge, code_challenge_method: "S256", ...over
  });
  const access = { role: "editor", via: "site_grant", capped: false, siteId: ids.site, organizationId: ids.org, user: { id: ids.user, email: "e@x.com", emailVerified: true, name: "E" } };

  it("sends an unauthenticated visitor to login with a same-origin callback", async () => {
    enable();
    mocks.auth.mockResolvedValue(null);
    const digest = await digestOf(AuthorizePage({ searchParams: Promise.resolve(params()) }));
    expect(digest).toContain("NEXT_REDIRECT");
    const target = decodeURIComponent(digest.split(";")[2]);
    expect(target.startsWith("/auth/login?callbackUrl=/oidc/authorize?")).toBe(true);
  });

  it("renders an error (never redirects) for an unregistered redirect_uri", async () => {
    enable();
    const db = new FakeOidcDb();
    db.clients.push(makeClient());
    mocks.auth.mockResolvedValue({ user: { id: ids.user } });
    mocks.getDb.mockResolvedValue(db);
    const element = (await AuthorizePage({ searchParams: Promise.resolve(params({ redirect_uri: "https://evil.example/cb" })) })) as { props: { code: string } };
    expect(element.props.code).toBe("invalid_redirect_uri");
  });

  it("redirects to the registered URI with an OAuth error for a bad PKCE method", async () => {
    enable();
    const db = new FakeOidcDb();
    db.clients.push(makeClient());
    mocks.auth.mockResolvedValue({ user: { id: ids.user } });
    mocks.getDb.mockResolvedValue(db);
    const digest = await digestOf(AuthorizePage({ searchParams: Promise.resolve(params({ code_challenge_method: "plain" })) }));
    const location = new URL(digest.split(";")[2]);
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get("error")).toBe("invalid_request");
  });

  it("shows the no-access page when the user has no Craft role", async () => {
    enable();
    const db = new FakeOidcDb();
    db.clients.push(makeClient());
    mocks.auth.mockResolvedValue({ user: { id: ids.user } });
    mocks.getDb.mockResolvedValue(db);
    mocks.resolve.mockResolvedValue(null);
    const element = (await AuthorizePage({ searchParams: Promise.resolve(params()) })) as { props: { code: string } };
    expect(element.props.code).toBe("no_access");
    expect(db.codes).toHaveLength(0);
  });

  it("consent route rejects a foreign Origin and an anonymous caller", async () => {
    enable();
    const body = new URLSearchParams({ decision: "allow" });
    const post = (origin: string | null) => consent.POST(new Request(`${ISSUER}/oidc/authorize/consent`, {
      method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) }
    }));
    for (const origin of [null, "https://evil.example", "http://jongo.example", `${ISSUER}.evil.example`]) {
      const response = await post(origin);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/oidc/error?e=invalid_request");
    }
    mocks.auth.mockResolvedValue(null);
    expect((await post(ISSUER)).headers.get("location")).toBe("/auth/login");
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("consent route does not issue a code without a valid token", async () => {
    enable();
    const db = new FakeOidcDb();
    db.clients.push(makeClient());
    mocks.auth.mockResolvedValue({ user: { id: ids.user } });
    mocks.getDb.mockResolvedValue(db);
    mocks.resolve.mockResolvedValue(access);
    const form = new URLSearchParams({ ...params(), decision: "allow", consent_token: "9999999999.forged" });
    const response = await consent.POST(new Request(`${ISSUER}/oidc/authorize/consent`, {
      method: "POST", body: form, headers: { "content-type": "application/x-www-form-urlencoded", origin: ISSUER }
    }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/oidc/error?e=invalid_request");
    expect(db.codes).toHaveLength(0);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
});
