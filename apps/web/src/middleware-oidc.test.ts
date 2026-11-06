import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ getToken: vi.fn() }));
vi.mock("next-auth/jwt", () => ({ getToken: mocks.getToken }));

import { middleware } from "@/middleware";

const isPassThrough = (response: Response) => response.headers.get("x-middleware-next") === "1";
const isLoginRedirect = (response: Response) =>
  response.status >= 300 && response.status < 400 && new URL(response.headers.get("location")!).pathname === "/auth/login";
// Anonymous /api/ callers get a readable 401; pages get the login redirect.
const isDenied = (response: Response, path: string) => (path.startsWith("/api/") ? response.status === 401 : isLoginRedirect(response));

const run = (method: string, path: string) => middleware(new NextRequest(`https://jongo.app${path}`, { method }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NEXTAUTH_SECRET", "a-real-test-secret");
  mocks.getToken.mockResolvedValue(null);
});
afterEach(() => vi.unstubAllEnvs());

describe("middleware: the three public OIDC method+path pairs", () => {
  it.each([
    ["GET", "/.well-known/openid-configuration"],
    ["HEAD", "/.well-known/openid-configuration"],
    ["GET", "/api/oidc/jwks"],
    ["HEAD", "/api/oidc/jwks"],
    ["POST", "/api/oidc/token"]
  ])("lets an anonymous %s %s through", async (method, path) => {
    expect(isPassThrough(await run(method, path))).toBe(true);
    expect(mocks.getToken).not.toHaveBeenCalled();
  });

  it.each([
    ["POST", "/.well-known/openid-configuration"],
    ["PUT", "/.well-known/openid-configuration"],
    ["POST", "/api/oidc/jwks"],
    ["DELETE", "/api/oidc/jwks"],
    ["GET", "/api/oidc/token"],
    ["HEAD", "/api/oidc/token"],
    ["PUT", "/api/oidc/token"],
    ["OPTIONS", "/api/oidc/token"],
    ["OPTIONS", "/api/oidc/jwks"]
  ])("keeps %s %s behind login (method restricted)", async (method, path) => {
    expect(isDenied(await run(method, path), path)).toBe(true);
  });

  it.each([
    "/api/oidc", "/api/oidc/", "/api/oidc/anything-else", "/api/oidc/token/extra", "/api/oidc/tokenx", "/api/oidc/token/",
    "/api/oidc/jwks/", "/api/oidc/jwks.json", "/api/oidc/jwks/extra", "/api/oidc/JWKS", "/api/oidc/Token", "/api/oidc/userinfo",
    "/api/oidc/revoke", "/api/oidc/introspect", "/api/oidc/register", "/api/oidc/token%2F",
    "/.well-known", "/.well-known/", "/.well-known/anything-else", "/.well-known/jwks.json", "/.well-known/oauth-authorization-server",
    "/.well-known/openid-configuration/", "/.well-known/openid-configuration.json", "/.well-known/openid-configurationx",
    "/.well-known/openid-configuration/extra", "/.well-known/OpenID-Configuration",
    "/x/api/oidc/token", "/xapi/oidc/token", "/oidc", "/oidc/authorize", "/oidc/authorize/consent", "/oidc/error"
  ])("keeps %s behind login for every method", async (path) => {
    for (const method of ["GET", "POST", "HEAD", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
      expect(isDenied(await run(method, path), path), `${method} ${path}`).toBe(true);
    }
  });

  it("sends an anonymous /oidc/authorize to login and preserves the full query for the return trip", async () => {
    const response = await run("GET", "/oidc/authorize?client_id=jc_x&state=s");
    const url = new URL(response.headers.get("location")!);
    expect(url.pathname).toBe("/auth/login");
    expect(url.searchParams.get("callbackUrl")).toBe("/oidc/authorize?client_id=jc_x&state=s");
  });

  it("lets a signed-in session reach /oidc/authorize", async () => {
    mocks.getToken.mockResolvedValue({ sub: "u" });
    expect(isPassThrough(await run("GET", "/oidc/authorize?client_id=x"))).toBe(true);
  });

  it("existing behaviour is unchanged: public pages stay public, private ones stay private", async () => {
    for (const path of ["/", "/pricing", "/auth/login", "/api/health", "/robots.txt", "/api/auth/session"]) {
      expect(isPassThrough(await run("GET", path)), path).toBe(true);
    }
    for (const path of ["/dashboard", "/api/sites", "/api/oidc-lookalike", "/api/oidcx/token"]) {
      // "/api/oidc-lookalike" and "/api/oidcx/token" must not inherit any prefix exemption.
      expect(isDenied(await run("GET", path), path), path).toBe(true);
    }
  });
});

describe("middleware source guard", () => {
  it("does not add OIDC paths to the startsWith PUBLIC_PATHS list or under /api/auth", async () => {
    const source = (await import("node:fs")).readFileSync(new URL("./middleware.ts", import.meta.url), "utf8");
    // The public list now lives in lib/public-paths.ts (whole-segment matching).
    const publicPathsSource = (await import("node:fs")).readFileSync(new URL("./lib/public-paths.ts", import.meta.url), "utf8");
    const list = /export const PUBLIC_PATHS = \[([\s\S]*?)\];/.exec(publicPathsSource)![1]
      .split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
    expect(list).not.toMatch(/oidc|well-known|jwks|token/i);
    const occurrences = source.match(/\/api\/oidc\/|\/\.well-known\//g) ?? [];
    // Exactly the three exact-equality comparisons: no regex, no startsWith, no wildcards.
    expect(source.match(/pathname === "\/\.well-known\/openid-configuration"/g)).toHaveLength(1);
    expect(source.match(/pathname === "\/api\/oidc\/jwks"/g)).toHaveLength(1);
    expect(source.match(/pathname === "\/api\/oidc\/token"/g)).toHaveLength(1);
    expect(source).not.toMatch(/startsWith\(["']\/(api\/oidc|\.well-known|oidc)/);
    expect(occurrences.length).toBeLessThanOrEqual(6);
  });
});
