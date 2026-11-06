import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashClientSecret } from "./clients";
import { issueAuthCode } from "./codes";
import { loadOidcKeys, publicJwks, type OidcKeys } from "./keys";
import { s256Challenge } from "./pkce";
import { clientAuthFailures } from "./rate-limit";
import { CLIENT_ID, CLIENT_SECRET, FakeOidcDb, REDIRECT_URI, ids, makeClient, testConfig } from "./testing";
import { handleTokenRequest, type TokenDeps } from "./token-endpoint";
import { verifyIdToken } from "./tokens";
import type { CraftAccessResult } from "@/lib/craft-access";

const ISSUER = "https://jongo.example";
const NOW = new Date("2026-11-06T12:00:00Z");
const verifier = "v".repeat(64);
const challenge = s256Challenge(verifier);

let keys: OidcKeys;
let db: FakeOidcDb;
let resolveAccess: ReturnType<typeof vi.fn>;
let ipCounter = 0;
const nextIp = () => `198.51.100.${++ipCounter % 250}-${ipCounter}`;

const access = (over: Partial<CraftAccessResult> = {}): CraftAccessResult => ({
  role: "editor", via: "site_grant", capped: false, siteId: ids.site, organizationId: ids.org,
  user: { id: ids.user, email: "ed@example.com", emailVerified: true, name: "Ed" }, ...over
});

async function newCode(over: Record<string, unknown> = {}) {
  return (await issueAuthCode(db as never, {
    oidcClientId: ids.client, userId: ids.user, redirectUri: REDIRECT_URI, codeChallenge: challenge, nonce: "nonce-1",
    scope: "openid email profile", authTime: new Date(NOW.getTime() - 5000), now: NOW, ...over
  })).code;
}

type Options = { basic?: boolean | string; body?: Record<string, string | undefined>; headers?: Record<string, string>; ip?: string; raw?: string };
async function call(code: string | undefined, options: Options = {}) {
  const body = new URLSearchParams();
  const fields: Record<string, string | undefined> = {
    grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier, ...options.body
  };
  const useBasic = options.basic !== false;
  if (!useBasic) { fields.client_id ??= CLIENT_ID; fields.client_secret ??= CLIENT_SECRET; }
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) body.set(k, v);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": options.ip ?? nextIp(), ...options.headers
  };
  if (useBasic) {
    headers.authorization = typeof options.basic === "string" ? options.basic : `Basic ${Buffer.from(`${encodeURIComponent(CLIENT_ID)}:${encodeURIComponent(CLIENT_SECRET)}`).toString("base64")}`;
  }
  const request = new Request("https://jongo.example/api/oidc/token", { method: "POST", headers, body: options.raw ?? body.toString() });
  const response = await handleTokenRequest(request, deps());
  return { response, json: (await response.clone().json().catch(() => null)) as Record<string, any> | null };
}
const deps = (): TokenDeps => ({ db: db as never, issuer: ISSUER, keys, resolveAccess: resolveAccess as never, now: () => NOW });

beforeEach(async () => {
  keys = await loadOidcKeys(testConfig());
  db = new FakeOidcDb();
  db.clients.push(makeClient());
  resolveAccess = vi.fn().mockResolvedValue(access());
  clientAuthFailures.reset(CLIENT_ID);
});

describe("token endpoint: success", () => {
  it("redeems with client_secret_basic and returns only an EdDSA ID token", async () => {
    const { response, json } = await call(await newCode());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(json!).sort()).toEqual(["expires_in", "id_token", "token_type"]);
    expect(json).not.toHaveProperty("access_token");
    expect(json).not.toHaveProperty("refresh_token");
    const claims = await verifyIdToken(json!.id_token, { issuer: ISSUER, audience: CLIENT_ID, nonce: "nonce-1", jwks: publicJwks(keys), now: NOW });
    expect(claims).toMatchObject({
      sub: ids.user, email: "ed@example.com", email_verified: true, name: "Ed",
      craft: { dataset: "production", role: "editor", siteId: ids.site, via: "site_grant" }
    });
    expect(db.audits.map((a) => a.action)).toEqual(["oidc.token.issue"]);
    expect(db.audits[0]).toMatchObject({ organizationId: ids.org, actorId: ids.user, resourceId: ids.client });
    expect(JSON.stringify(db.audits)).not.toContain(json!.id_token);
  });

  it("also accepts client_secret_post", async () => {
    const { response } = await call(await newCode(), { basic: false });
    expect(response.status).toBe(200);
  });

  it("takes the dataset from the client registration, not the request", async () => {
    db.clients[0].datasetName = "staging-data";
    const { json } = await call(await newCode(), { body: { dataset: "production" } });
    const claims = await verifyIdToken(json!.id_token, { issuer: ISSUER, audience: CLIENT_ID, jwks: publicJwks(keys), now: NOW });
    expect((claims.craft as { dataset: string }).dataset).toBe("staging-data");
  });

  it("re-resolves the role at redemption: a role change in the 60 s window is honoured", async () => {
    const code = await newCode();
    resolveAccess.mockResolvedValue(access({ role: "reader" }));
    const { json } = await call(code);
    const claims = await verifyIdToken(json!.id_token, { issuer: ISSUER, audience: CLIENT_ID, jwks: publicJwks(keys), now: NOW });
    expect((claims.craft as { role: string }).role).toBe("reader");
    expect(resolveAccess).toHaveBeenCalledWith(ids.user, ids.site);
  });

  it("honours the previous secret during the overlap window", async () => {
    db.clients[0] = makeClient({ secretHash: hashClientSecret("jcs_brand-new"), previousSecretHash: hashClientSecret(CLIENT_SECRET), previousSecretExpiresAt: new Date(NOW.getTime() + 3600_000) });
    expect((await call(await newCode())).response.status).toBe(200);
  });
});

describe("token endpoint: platform admin audit", () => {
  it("audits every platform_admin issuance with reason platform_admin and carries via in the token", async () => {
    resolveAccess.mockResolvedValue(access({ role: "admin", via: "platform_admin" }));
    const first = await call(await newCode());
    const second = await call(await newCode());
    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(200);
    const issued = db.audits.filter((a) => a.action === "oidc.token.issue");
    expect(issued).toHaveLength(2);
    for (const row of issued) expect(row.details).toMatchObject({ reason: "platform_admin", via: "platform_admin", role: "admin" });
    const claims = await verifyIdToken(first.json!.id_token, { issuer: ISSUER, audience: CLIENT_ID, jwks: publicJwks(keys), now: NOW });
    expect((claims.craft as { via: string; role: string })).toMatchObject({ via: "platform_admin", role: "admin" });
  });

  it("issues no token when the platform_admin audit row cannot be written", async () => {
    resolveAccess.mockResolvedValue(access({ role: "admin", via: "platform_admin" }));
    db.failAudit = true;
    const { response, json } = await call(await newCode());
    expect(response.status).toBe(500);
    expect(json).toEqual({ error: "server_error", error_description: "Could not record the sign-in" });
  });

  it("does not block ordinary sign-ins when audit is unavailable", async () => {
    db.failAudit = true;
    expect((await call(await newCode())).response.status).toBe(200);
  });
});

describe("token endpoint: client authentication", () => {
  it.each([
    ["wrong secret", `Basic ${Buffer.from(`${CLIENT_ID}:wrong`).toString("base64")}`],
    ["unknown client", `Basic ${Buffer.from(`jc_BBBBBBBBBBBBBBBBBBBBBB:${CLIENT_SECRET}`).toString("base64")}`],
    ["empty secret", `Basic ${Buffer.from(`${CLIENT_ID}:`).toString("base64")}`],
    ["no colon", `Basic ${Buffer.from("nocolon").toString("base64")}`],
    ["garbage", "Basic !!!"]
  ])("rejects %s with 401 invalid_client and burns nothing", async (_n, basic) => {
    const code = await newCode();
    const { response, json } = await call(code, { basic });
    expect(response.status).toBe(401);
    expect(json).toEqual({ error: "invalid_client" });
    expect(response.headers.get("www-authenticate")).toContain("Basic");
    expect(db.codes[0].consumedAt).toBeNull();
    expect((await call(code)).response.status).toBe(200);
  });

  it("rejects a disabled client and a rotated-out secret", async () => {
    db.clients[0].status = "disabled";
    expect((await call(await newCode())).response.status).toBe(401);
    db.clients[0] = makeClient({ secretHash: hashClientSecret("jcs_brand-new"), previousSecretHash: hashClientSecret(CLIENT_SECRET), previousSecretExpiresAt: new Date(NOW.getTime() - 1) });
    expect((await call(await newCode())).response.status).toBe(401);
  });

  it("rejects using both authentication methods, a mismatched client_id, and missing credentials", async () => {
    const code = await newCode();
    expect((await call(code, { body: { client_secret: CLIENT_SECRET } })).response.status).toBe(400);
    expect((await call(code, { body: { client_id: "jc_BBBBBBBBBBBBBBBBBBBBBB" } })).response.status).toBe(400);
    expect((await call(code, { basic: false, body: { client_secret: "", client_id: CLIENT_ID } })).json).toMatchObject({ error: "invalid_client" });
  });

  it("locks the client temporarily after 5 failed authentications and audits denials", async () => {
    const bad = `Basic ${Buffer.from(`${CLIENT_ID}:wrong`).toString("base64")}`;
    for (let i = 0; i < 5; i++) expect((await call("x", { basic: bad })).response.status).toBe(401);
    const locked = await call(await newCode());
    expect(locked.response.status).toBe(429);
    expect(locked.response.headers.get("retry-after")).toBe("900");
    expect(db.audits.filter((a) => a.action === "oidc.token.deny" && a.details.reason === "bad_client_secret")).toHaveLength(5);
  });

  it("rate limits per client and IP", async () => {
    const ip = "203.0.113.77";
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await call("x".repeat(43), { ip, body: { grant_type: "nope" } })).response.status);
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});

describe("token endpoint: request shape", () => {
  it("rejects non-form content types, browser requests and oversized or repeated parameters", async () => {
    const code = await newCode();
    expect((await call(code, { headers: { "content-type": "application/json" } })).response.status).toBe(400);
    expect((await call(code, { headers: { "content-type": "text/plain" } })).response.status).toBe(400);
    expect((await call(code, { headers: { origin: "https://evil.example" } })).response.status).toBe(400);
    expect((await call(code, { raw: `grant_type=authorization_code&code=${code}&code=${code}` })).response.status).toBe(400);
    expect((await call(code, { raw: "a=".padEnd(9000, "b") })).response.status).toBe(400);
    expect(db.codes[0].consumedAt).toBeNull();
  });

  it("accepts a charset parameter on the content type", async () => {
    expect((await call(await newCode(), { headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" } })).response.status).toBe(200);
  });

  it.each([
    ["refresh_token", { grant_type: "refresh_token" }],
    ["password", { grant_type: "password" }],
    ["client_credentials", { grant_type: "client_credentials" }],
    ["missing", { grant_type: undefined }]
  ])("supports authorization_code only (%s)", async (_n, body) => {
    const { response, json } = await call(await newCode(), { body });
    expect(response.status).toBe(400);
    expect(json?.error).toBe("unsupported_grant_type");
  });

  it("requires code, redirect_uri and a PKCE verifier", async () => {
    const code = await newCode();
    for (const body of [{ redirect_uri: undefined }, { code_verifier: undefined }]) {
      expect((await call(code, { body })).json?.error).toBe("invalid_request");
    }
    expect((await call(undefined)).json?.error).toBe("invalid_request");
  });
});

describe("token endpoint: code redemption failures", () => {
  it("returns a uniform invalid_grant for every code problem", async () => {
    const cases: Array<[string, () => Promise<{ code: string; options?: Options }>]> = [
      ["unknown", async () => ({ code: "a".repeat(43) })],
      ["malformed", async () => ({ code: "short" })],
      ["wrong verifier", async () => ({ code: await newCode(), options: { body: { code_verifier: "w".repeat(64) } } })],
      ["short verifier", async () => ({ code: await newCode(), options: { body: { code_verifier: "w" } } })],
      ["redirect mismatch", async () => ({ code: await newCode(), options: { body: { redirect_uri: `${REDIRECT_URI}/` } } })],
      ["expired", async () => ({ code: await newCode({ now: new Date(NOW.getTime() - 61_000) }) })],
      ["other client", async () => ({ code: await newCode({ oidcClientId: "20000000-0000-4000-8000-0000000000ff" }) })]
    ];
    for (const [name, make] of cases) {
      const { code, options } = await make();
      const { response, json } = await call(code, options);
      expect(response.status, name).toBe(400);
      expect(json, name).toEqual({ error: "invalid_grant" });
    }
  });

  it("denies replay, audits oidc.code.replay and issues no second token", async () => {
    const code = await newCode();
    expect((await call(code)).response.status).toBe(200);
    const replay = await call(code);
    expect(replay.response.status).toBe(400);
    expect(replay.json).toEqual({ error: "invalid_grant" });
    expect(db.audits.map((a) => a.action)).toEqual(["oidc.token.issue", "oidc.code.replay"]);
  });

  it("a code issued to client A cannot be redeemed by client B", async () => {
    const other = makeClient({ id: "20000000-0000-4000-8000-0000000000bb", clientId: "jc_BBBBBBBBBBBBBBBBBBBBBB", secretHash: hashClientSecret("jcs_b-secret") });
    db.clients.push(other);
    const code = await newCode();
    const basic = `Basic ${Buffer.from("jc_BBBBBBBBBBBBBBBBBBBBBB:jcs_b-secret").toString("base64")}`;
    expect((await call(code, { basic })).json).toEqual({ error: "invalid_grant" });
  });

  it("denies when access was revoked after the code was issued", async () => {
    const code = await newCode();
    resolveAccess.mockResolvedValue(null);
    const { response, json } = await call(code);
    expect(response.status).toBe(400);
    expect(json).toEqual({ error: "invalid_grant" });
    expect(db.audits.at(-1)).toMatchObject({ action: "oidc.token.deny", details: { reason: "access_revoked" } });
  });

  it("denies when the access result belongs to a different site", async () => {
    resolveAccess.mockResolvedValue(access({ siteId: "20000000-0000-4000-8000-0000000000cc" }));
    expect((await call(await newCode())).response.status).toBe(400);
  });
});

describe("scope handling", () => {
  it("omits email and name claims when only openid was granted", async () => {
    const { json } = await call(await newCode({ scope: "openid" }));
    const claims = await verifyIdToken(json!.id_token, { issuer: ISSUER, audience: CLIENT_ID, jwks: publicJwks(keys), now: NOW });
    expect(claims).not.toHaveProperty("email");
    expect(claims).not.toHaveProperty("name");
    expect(claims.craft).toBeDefined();
  });
});
