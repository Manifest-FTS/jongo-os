import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), world: { current: null as any } }));
vi.mock("@/lib/auth.config", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db", () => ({
  getDb: async () => mocks.world.current?.db ?? null,
  db: new Proxy({}, { get: (_target, property) => mocks.world.current.db[property] })
}));
vi.mock("@/lib/rbac", () => ({ isPlatformAdminUser: (userId: string) => mocks.world.current.isPlatformAdmin(userId) }));
vi.mock("@/lib/tenant-route-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant-route-access")>()),
  resolveSiteAccess: (siteId: string, userId: string) => mocks.world.current.resolveSiteAccess(siteId, userId)
}));
vi.mock("@/lib/permissions", () => ({ getPlatformAdminContacts: async () => ["support@jongo.example"] }));

import * as accessRoute from "@/app/api/sites/[siteId]/craft-access/route";
import * as revokeRoute from "@/app/api/sites/[siteId]/craft-access/[userId]/route";
import * as clientRoute from "@/app/api/sites/[siteId]/craft-client/route";
import * as rotateRoute from "@/app/api/sites/[siteId]/craft-client/rotate/route";
import { CRAFT_ROLES, craftManagerCapacity, grantCeiling, grantCraftAccess, resolveCraftAccess, type CraftManagerCapacity } from "@/lib/craft-access";
import { verifyClientSecret } from "@/lib/oidc/clients";
import { newSigningKeyJwk } from "@/lib/oidc/testing";
import {
  CraftWorld, OTHER_ADMIN, ORG_ADMIN, ORG_COLLAB, OWNER, SITE, SITE_ADMIN, STRANGER, SUPER, TARGET, TARGET_EMAIL, id
} from "./testing";

let world: CraftWorld;
let logged: string[];

const ctx = (siteId: string = SITE) => ({ params: Promise.resolve({ siteId }) });
const userCtx = (userId: string, siteId: string = SITE) => ({ params: Promise.resolve({ siteId, userId }) });
const request = (method: string, body?: unknown, headers: Record<string, string> = {}) => new Request("https://jongo.example/api/sites/x", {
  method,
  body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), "x-forwarded-for": "203.0.113.9", "user-agent": "vitest", ...headers }
});
const as = (userId: string | null) => mocks.auth.mockResolvedValue(userId ? { user: { id: userId } } : null);
const json = async (response: Response) => JSON.parse(await response.text());

function enable() {
  vi.stubEnv("JONGO_OIDC_ENABLED", "true");
  vi.stubEnv("JONGO_OIDC_ISSUER", "https://jongo.example");
  vi.stubEnv("JONGO_OIDC_SIGNING_KEY", newSigningKeyJwk());
  vi.stubEnv("NEXTAUTH_SECRET", "a-real-test-secret");
  vi.stubEnv("JONGO_CMS_ENABLED", "true");
}

beforeEach(() => {
  vi.resetAllMocks();
  world = new CraftWorld();
  mocks.world.current = world;
  logged = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
  }
  enable();
});
afterEach(() => vi.unstubAllEnvs());

type Endpoint = { name: string; setup?: (w: CraftWorld) => void; run: () => Promise<Response>; ok: number };
const endpoints: Endpoint[] = [
  { name: "GET craft-access", run: () => accessRoute.GET(request("GET"), ctx()), ok: 200 },
  { name: "POST craft-access (grant)", run: () => accessRoute.POST(request("POST", { email: TARGET_EMAIL, role: "editor" }), ctx()), ok: 201 },
  { name: "DELETE craft-access/[userId]", setup: (w) => w.addGrant(TARGET, "editor"), run: () => revokeRoute.DELETE(request("DELETE"), userCtx(TARGET)), ok: 200 },
  { name: "GET craft-client", setup: (w) => w.addClient(), run: () => clientRoute.GET(request("GET"), ctx()), ok: 200 },
  { name: "POST craft-client (create)", run: () => clientRoute.POST(request("POST", { redirectUris: ["https://golf.example/craft/auth/callback"] }), ctx()), ok: 201 },
  { name: "PATCH craft-client", setup: (w) => w.addClient(), run: () => clientRoute.PATCH(request("PATCH", { datasetName: "staging" }), ctx()), ok: 200 },
  { name: "POST craft-client/rotate", setup: (w) => w.addClient(), run: () => rotateRoute.POST(request("POST", {}), ctx()), ok: 200 }
];

describe("authorization matrix", () => {
  const actors: Array<[string, string | null, number | "ok"]> = [
    ["anonymous", null, 401],
    ["client collaborator", ORG_COLLAB, 403],
    ["app-level admin without client admin rights", SITE_ADMIN, 403],
    ["client admin", ORG_ADMIN, "ok"],
    ["client owner", OWNER, "ok"],
    ["platform super admin", SUPER, "ok"],
    // Admin of a different client: has no membership here, so the app is invisible to them (existing site-route convention).
    ["another client's admin", OTHER_ADMIN, 404],
    ["unrelated user", STRANGER, 404]
  ];

  describe.each(endpoints)("$name", (endpoint) => {
    it.each(actors)("%s", async (_label, actor, expected) => {
      endpoint.setup?.(world);
      const before = JSON.stringify({ grants: world.grants, clients: world.clients });
      as(actor);
      const response = await endpoint.run();
      expect(response.status).toBe(expected === "ok" ? endpoint.ok : expected);
      if (expected !== "ok") {
        expect(JSON.stringify({ grants: world.grants, clients: world.clients })).toBe(before);
        expect(world.audits).toEqual([]);
      } else {
        expect(world.audits.length > 0 || endpoint.name.startsWith("GET")).toBe(true);
      }
    });

    it("deleted site is 404 even for the owner and a super admin", async () => {
      endpoint.setup?.(world);
      world.site.deletedAt = new Date();
      for (const actor of [OWNER, SUPER]) {
        as(actor);
        expect((await endpoint.run()).status).toBe(404);
      }
      expect(world.audits).toEqual([]);
    });

    it("a deleted user's lingering session is 404", async () => {
      endpoint.setup?.(world);
      world.users.get(OWNER)!.deletedAt = new Date();
      as(OWNER);
      expect((await endpoint.run()).status).toBe(404);
    });
  });

  it("a malformed or unknown siteId is 404 without touching the database", async () => {
    as(OWNER);
    for (const siteId of ["not-a-uuid", "../../etc", "", id(999), "00000000-0000-0000-0000-000000000000"]) {
      expect((await accessRoute.GET(request("GET"), ctx(siteId))).status, siteId).toBe(404);
      expect((await clientRoute.GET(request("GET"), ctx(siteId))).status, siteId).toBe(404);
    }
    expect((await revokeRoute.DELETE(request("DELETE"), userCtx("not-a-uuid"))).status).toBe(404);
    expect(world.audits).toEqual([]);
  });

  it("org-level collaborator who is also a site admin is still not a manager", async () => {
    world.siteCollaborators.push({ id: "x", siteId: SITE, userId: ORG_COLLAB, role: "admin", deletedAt: null });
    as(ORG_COLLAB);
    expect((await accessRoute.GET(request("GET"), ctx())).status).toBe(403);
  });

  it("a revoked (soft-deleted) client admin loses manager rights", async () => {
    world.orgCollaborators.find((c) => c.userId === ORG_ADMIN)!.deletedAt = new Date();
    as(ORG_ADMIN);
    expect((await accessRoute.GET(request("GET"), ctx())).status).toBe(404);
  });
});

describe("flag off: every new route is inert", () => {
  const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
  const modules: Record<string, Record<string, unknown>> = { access: accessRoute, revoke: revokeRoute, client: clientRoute, rotate: rotateRoute };

  it.each(["undefined", "", "false", "TRUE", "1", " true", "yes"])("JONGO_OIDC_ENABLED=%j answers 404 to every method of every route", async (value) => {
    vi.unstubAllEnvs();
    if (value !== "undefined") vi.stubEnv("JONGO_OIDC_ENABLED", value);
    as(OWNER);
    for (const [name, mod] of Object.entries(modules)) {
      for (const method of METHODS) {
        const handler = mod[method] as ((r: Request, c: unknown) => Promise<Response>) | undefined;
        expect(handler, `${name} must export ${method} so no method can skip the flag check`).toBeTypeOf("function");
        const response = await handler!(request(method, method === "GET" || method === "HEAD" || method === "OPTIONS" ? undefined : {}), name === "revoke" ? userCtx(TARGET) : ctx());
        expect(response.status, `${name} ${method}`).toBe(404);
        expect(await response.text()).toBe("Not Found");
      }
    }
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(world.calls).toEqual([]);
    expect(world.audits).toEqual([]);
    expect(world.grants).toEqual([]);
    expect(world.clients).toEqual([]);
  });

  it("flag on: methods a route does not implement are 405, not 404", async () => {
    as(OWNER);
    expect((await accessRoute.PUT()).status).toBe(405);
    expect((await rotateRoute.GET()).status).toBe(405);
  });
});

describe("role escalation prevention", () => {
  it("every manager capacity may grant up to admin and no further", () => {
    for (const capacity of ["platform_admin", "org_owner", "org_admin"] as CraftManagerCapacity[]) {
      expect(grantCeiling(capacity)).toBe("admin");
      expect(CRAFT_ROLES.indexOf(grantCeiling(capacity))).toBe(CRAFT_ROLES.length - 1);
    }
  });

  it("only owner, client admin and platform admin hold a manager capacity", () => {
    const base = { userId: "u", ownerId: "o", orgRole: null as unknown, isPlatformAdmin: false };
    expect(craftManagerCapacity(base)).toBeNull();
    expect(craftManagerCapacity({ ...base, orgRole: "collaborator" })).toBeNull();
    expect(craftManagerCapacity({ ...base, orgRole: "owner" })).toBeNull();
    expect(craftManagerCapacity({ ...base, orgRole: "admin" })).toBe("org_admin");
    expect(craftManagerCapacity({ ...base, ownerId: "u" })).toBe("org_owner");
    expect(craftManagerCapacity({ ...base, isPlatformAdmin: true })).toBe("platform_admin");
    expect(craftManagerCapacity({ ...base, ownerId: "u", isPlatformAdmin: true })).toBe("org_owner");
  });

  it.each([ORG_COLLAB, SITE_ADMIN, STRANGER])("the grant function itself refuses %s, for every role, even called directly", async (actor) => {
    for (const role of CRAFT_ROLES) {
      const result = await grantCraftAccess({ actorId: actor, siteId: SITE, userId: TARGET, role });
      expect(result.ok, role).toBe(false);
    }
    expect(world.grants).toEqual([]);
  });

  it("a user who holds only editor cannot hand out admin (explicit grants confer no management)", async () => {
    world.addGrant(ORG_COLLAB, "editor");
    as(ORG_COLLAB);
    const response = await accessRoute.POST(request("POST", { email: TARGET_EMAIL, role: "admin" }), ctx());
    expect(response.status).toBe(403);
    expect(world.grants.map((g) => g.userId)).toEqual([ORG_COLLAB]);
  });

  it.each([["owner", OWNER], ["client admin", ORG_ADMIN], ["super admin", SUPER]])("%s may grant admin", async (_label, actor) => {
    as(actor);
    const response = await accessRoute.POST(request("POST", { email: TARGET_EMAIL, role: "admin" }), ctx());
    expect(response.status).toBe(201);
    expect(world.grants[0]).toMatchObject({ userId: TARGET, role: "admin", grantedByUserId: actor });
  });

  it("the grant never takes a role, actor or site from the client", async () => {
    as(ORG_ADMIN);
    const response = await accessRoute.POST(request("POST", { email: TARGET_EMAIL, role: "reader", grantedByUserId: OWNER, siteId: id(999) }), ctx());
    expect(response.status).toBe(400);
    expect(world.grants).toEqual([]);
  });
});

describe("craft-access: listing, granting, revoking", () => {
  it("lists explicit grants plus read-only inherited rows (super admin, owner, client admins)", async () => {
    world.addGrant(TARGET, "reader", ORG_ADMIN);
    as(ORG_ADMIN);
    const body = await json(await accessRoute.GET(request("GET"), ctx()));
    expect(body.maxGrantableRole).toBe("admin");
    expect(body.explicit).toEqual([expect.objectContaining({ userId: TARGET, email: TARGET_EMAIL, role: "reader", grantedBy: { email: "orgadmin@example.com", name: "orgadmin" } })]);
    expect(body.inherited.map((row: { source: string }) => row.source)).toEqual(["platform_admin", "org_owner", "org_admin"]);
    expect(body.inherited[0]).toMatchObject({ label: "Jongo Super Admin", role: "admin", userId: null, contacts: ["support@jongo.example"] });
    expect(body.inherited[1]).toMatchObject({ role: "admin", userId: OWNER });
    expect(body.inherited[2]).toMatchObject({ role: "admin", userId: ORG_ADMIN });
  });

  it("grants by email (any live Jongo user), case-insensitively, then updates the role in place", async () => {
    as(OWNER);
    const first = await accessRoute.POST(request("POST", { email: ` ${TARGET_EMAIL.toUpperCase()} `, role: "reader" }), ctx());
    expect(first.status).toBe(201);
    expect(await json(first)).toMatchObject({ created: true, role: "reader", userId: TARGET });
    const second = await accessRoute.POST(request("POST", { email: TARGET_EMAIL, role: "publisher" }), ctx());
    expect(second.status).toBe(200);
    expect(world.grants).toHaveLength(1);
    expect(world.grants[0].role).toBe("publisher");
  });

  it("grants by userId only to someone already in this client/app or already holding a grant", async () => {
    as(OWNER);
    for (const member of [ORG_COLLAB, SITE_ADMIN, ORG_ADMIN]) {
      expect((await accessRoute.POST(request("POST", { userId: member, role: "editor" }), ctx())).status, member).toBe(201);
    }
    expect((await accessRoute.POST(request("POST", { userId: STRANGER, role: "editor" }), ctx())).status).toBe(404);
    expect((await accessRoute.POST(request("POST", { userId: id(777), role: "editor" }), ctx())).status).toBe(404);
    world.addGrant(TARGET, "reader");
    expect((await accessRoute.POST(request("POST", { userId: TARGET, role: "editor" }), ctx())).status).toBe(200);
    expect(world.grants.find((g) => g.userId === TARGET)!.role).toBe("editor");
  });

  it("refuses unknown or deleted users by email without creating anything", async () => {
    as(OWNER);
    expect((await accessRoute.POST(request("POST", { email: "nobody@example.com", role: "reader" }), ctx())).status).toBe(404);
    world.users.get(TARGET)!.deletedAt = new Date();
    expect((await accessRoute.POST(request("POST", { email: TARGET_EMAIL, role: "reader" }), ctx())).status).toBe(404);
    expect(world.grants).toEqual([]);
  });

  it("revokes, 404s when there is nothing to revoke, and cannot revoke inherited access", async () => {
    world.addGrant(TARGET, "editor");
    as(ORG_ADMIN);
    expect((await revokeRoute.DELETE(request("DELETE"), userCtx(TARGET))).status).toBe(200);
    expect(world.grants[0].revokedAt).toBeInstanceOf(Date);
    expect((await revokeRoute.DELETE(request("DELETE"), userCtx(TARGET))).status).toBe(404);
    expect((await revokeRoute.DELETE(request("DELETE"), userCtx(OWNER))).status).toBe(404);
  });

  it("revoking takes effect in the effective-role resolution used by sign-in; updates too", async () => {
    as(OWNER);
    await accessRoute.POST(request("POST", { email: TARGET_EMAIL, role: "editor" }), ctx());
    expect(await resolveCraftAccess(TARGET, SITE)).toMatchObject({ role: "editor", via: "site_grant" });
    await accessRoute.POST(request("POST", { userId: TARGET, role: "publisher" }), ctx());
    expect(await resolveCraftAccess(TARGET, SITE)).toMatchObject({ role: "publisher" });
    expect((await revokeRoute.DELETE(request("DELETE"), userCtx(TARGET))).status).toBe(200);
    expect(await resolveCraftAccess(TARGET, SITE)).toBeNull();
  });

  it("writes an audit row per change, with provenance and no more than ids and codes", async () => {
    as(ORG_ADMIN);
    await accessRoute.POST(request("POST", { email: TARGET_EMAIL, role: "editor" }), ctx());
    await accessRoute.POST(request("POST", { email: TARGET_EMAIL, role: "reader" }), ctx());
    await revokeRoute.DELETE(request("DELETE"), userCtx(TARGET));
    expect(world.audits).toEqual([
      expect.objectContaining({ action: "craft.access.grant", actorId: ORG_ADMIN, organizationId: id(2), resourceType: "site", resourceId: SITE, ipAddress: "203.0.113.9", userAgent: "vitest", details: { targetUserId: TARGET, role: "editor", replaced: false } }),
      expect.objectContaining({ action: "craft.access.grant", details: { targetUserId: TARGET, role: "reader", replaced: true } }),
      expect.objectContaining({ action: "craft.access.revoke", details: { targetUserId: TARGET } })
    ]);
  });
});

describe("input validation and bounds", () => {
  const post = (body: unknown, headers?: Record<string, string>) => accessRoute.POST(request("POST", body, headers), ctx());

  it.each([
    ["no body fields", {}],
    ["email and userId together", { email: TARGET_EMAIL, userId: TARGET, role: "reader" }],
    ["neither email nor userId", { role: "reader" }],
    ["missing role", { email: TARGET_EMAIL }],
    ["owner role", { email: TARGET_EMAIL, role: "owner" }],
    ["super_admin role", { email: TARGET_EMAIL, role: "super_admin" }],
    ["upper-case role", { email: TARGET_EMAIL, role: "Admin" }],
    ["role as array", { email: TARGET_EMAIL, role: ["admin"] }],
    ["role as object", { email: TARGET_EMAIL, role: { $ne: "x" } }],
    ["numeric email", { email: 5, role: "reader" }],
    ["malformed email", { email: "not-an-email", role: "reader" }],
    ["oversized email", { email: `${"a".repeat(300)}@example.com`, role: "reader" }],
    ["userId not a UUID", { userId: "1; DROP TABLE", role: "reader" }],
    ["userId as number", { userId: 5, role: "reader" }],
    ["extra field", { email: TARGET_EMAIL, role: "reader", organizationId: "x" }],
    ["JSON array", [{ email: TARGET_EMAIL, role: "reader" }]],
    ["JSON null", null],
    ["JSON string", "reader"]
  ])("400 for %s", async (_label, body) => {
    as(OWNER);
    const response = await post(body === "reader" ? JSON.stringify("reader") : body);
    expect(response.status).toBe(400);
    expect(world.grants).toEqual([]);
    expect(world.audits).toEqual([]);
  });

  it("rejects non-JSON content, malformed JSON and oversized bodies", async () => {
    as(OWNER);
    expect((await accessRoute.POST(new Request("https://x.test/", { method: "POST", body: "email=a", headers: { "content-type": "application/x-www-form-urlencoded" } }), ctx())).status).toBe(415);
    expect((await accessRoute.POST(new Request("https://x.test/", { method: "POST", body: "{}" }), ctx())).status).toBe(415);
    expect((await post("{not json")).status).toBe(400);
    expect((await post(JSON.stringify({ email: TARGET_EMAIL, role: "reader", pad: "x".repeat(20_000) }))).status).toBe(413);
    expect((await post("{}", { "content-length": "999999" })).status).toBe(413);
    expect(world.grants).toEqual([]);
  });

  describe("client create/update", () => {
    const create = (body: unknown) => clientRoute.POST(request("POST", body), ctx());
    const URI = "https://golf.example/craft/auth/callback";

    it.each([
      ["no redirect URIs", {}],
      ["empty list", { redirectUris: [] }],
      ["string instead of list", { redirectUris: URI }],
      ["wildcard", { redirectUris: ["https://*.golf.example/cb"] }],
      ["fragment", { redirectUris: [`${URI}#x`] }],
      ["userinfo", { redirectUris: ["https://a:b@golf.example/cb"] }],
      ["http remote", { redirectUris: ["http://golf.example/cb"] }],
      ["eleven URIs", { redirectUris: Array.from({ length: 11 }, (_, i) => `https://golf.example/${i}`) }],
      ["bad dataset", { redirectUris: [URI], datasetName: "Production!" }],
      ["long name", { redirectUris: [URI], name: "n".repeat(200) }],
      ["extra field", { redirectUris: [URI], secretHash: "x" }],
      ["client-chosen secret", { redirectUris: [URI], clientSecret: "chosen" }],
      ["client-chosen id", { redirectUris: [URI], clientId: "jc_chosen" }]
    ])("400 for %s", async (_label, body) => {
      as(OWNER);
      expect((await create(body)).status).toBe(400);
      expect(world.clients).toEqual([]);
      expect(world.audits).toEqual([]);
    });

    it("http://localhost is accepted outside production only", async () => {
      as(OWNER);
      vi.stubEnv("NODE_ENV", "production");
      expect((await create({ redirectUris: ["http://localhost:3000/craft/auth/callback"] })).status).toBe(400);
      vi.stubEnv("NODE_ENV", "development");
      expect((await create({ redirectUris: ["http://localhost:3000/craft/auth/callback", URI] })).status).toBe(201);
      expect(world.clients[0].allowedOrigins).toEqual(["http://localhost:3000", "https://golf.example"]);
    });

    it("update: validates, requires at least one field, 404s without a client", async () => {
      as(OWNER);
      expect((await clientRoute.PATCH(request("PATCH", { datasetName: "x" }), ctx())).status).toBe(404);
      world.addClient();
      for (const body of [{}, { status: "deleted" }, { redirectUris: [] }, { redirectUris: ["https://*.x.example/"] }, { datasetName: "BAD" }, { secretHash: "x" }, { clientId: "jc_other" }]) {
        expect((await clientRoute.PATCH(request("PATCH", body), ctx())).status, JSON.stringify(body)).toBe(400);
      }
      const ok = await clientRoute.PATCH(request("PATCH", { redirectUris: ["https://new.example/cb"], datasetName: "staging" }), ctx());
      expect(ok.status).toBe(200);
      expect(world.clients[0]).toMatchObject({ redirectUris: ["https://new.example/cb"], allowedOrigins: ["https://new.example"], datasetName: "staging" });
    });

    it("one client per app", async () => {
      as(OWNER);
      expect((await create({ redirectUris: [URI] })).status).toBe(201);
      expect((await create({ redirectUris: [URI] })).status).toBe(409);
      expect(world.clients).toHaveLength(1);
    });
  });
});

describe("OIDC client lifecycle and secret handling", () => {
  const URI = "https://golf.example/craft/auth/callback";
  const everything = () => JSON.stringify([world.audits, logged]);

  async function createClient() {
    as(OWNER);
    const response = await clientRoute.POST(request("POST", { redirectUris: [URI], datasetName: "production" }), ctx());
    expect(response.status).toBe(201);
    return json(response);
  }

  it("create returns the secret exactly once, hashed at rest, with the env names and the public issuer", async () => {
    const body = await createClient();
    expect(body.secretShownOnce).toBe(true);
    expect(body.clientSecret).toMatch(/^jcs_[A-Za-z0-9_-]{43}$/);
    expect(body.client.clientId).toMatch(/^jc_[A-Za-z0-9_-]{22}$/);
    expect(body.client).toMatchObject({ status: "active", datasetName: "production", redirectUris: [URI], rotatedAt: null });
    expect(body.issuer).toBe("https://jongo.example");
    expect(body.envNames).toMatchObject({ clientSecret: "CRAFT_SSO_CLIENT_SECRET", issuer: "CRAFT_SSO_ISSUER", clientId: "CRAFT_SSO_CLIENT_ID", redirectUri: "CRAFT_SSO_REDIRECT_URI" });
    const stored = world.clients[0];
    expect(stored.secretHash).not.toContain(body.clientSecret);
    expect(verifyClientSecret(body.clientSecret, stored.secretHash)).toBe(true);
    expect(stored.createdById).toBe(OWNER);
  });

  it("the secret never appears again: not in GET, PATCH, list responses, audit rows or logs", async () => {
    const created = await createClient();
    const secret: string = created.clientSecret;
    const hash: string = world.clients[0].secretHash;
    const responses = [
      await clientRoute.GET(request("GET"), ctx()),
      await clientRoute.PATCH(request("PATCH", { datasetName: "staging" }), ctx()),
      await clientRoute.PATCH(request("PATCH", { status: "disabled" }), ctx()),
      await clientRoute.PATCH(request("PATCH", { status: "active" }), ctx()),
      await accessRoute.GET(request("GET"), ctx())
    ];
    for (const response of responses) {
      const text = await response.text();
      expect(response.status).toBe(200);
      for (const forbidden of [secret, hash, "secretHash", "previousSecretHash", "jcs_", "v1$", "secretShownOnce"]) expect(text, forbidden).not.toContain(forbidden);
    }
    expect(everything()).not.toContain(secret);
    expect(everything()).not.toContain(hash);
    expect(everything()).not.toMatch(/jcs_|v1\$/);
  });

  it("every response is no-store", async () => {
    await createClient();
    for (const response of [await clientRoute.GET(request("GET"), ctx()), await rotateRoute.POST(request("POST", {}), ctx())]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("rotate: new secret shown once, old one valid for 24 h, then rotatedAt is reported", async () => {
    const created = await createClient();
    const oldHash: string = world.clients[0].secretHash;
    const response = await rotateRoute.POST(request("POST", {}), ctx());
    const body = await json(response);
    expect(response.status).toBe(200);
    expect(body.clientSecret).toMatch(/^jcs_/);
    expect(body.clientSecret).not.toBe(created.clientSecret);
    const stored = world.clients[0];
    expect(verifyClientSecret(body.clientSecret, stored.secretHash)).toBe(true);
    expect(stored.previousSecretHash).toBe(oldHash);
    expect(verifyClientSecret(created.clientSecret, stored.previousSecretHash)).toBe(true);
    const window = stored.previousSecretExpiresAt.getTime() - Date.now();
    expect(window).toBeGreaterThan(23.9 * 3600_000);
    expect(window).toBeLessThanOrEqual(24 * 3600_000);
    expect(body.client.rotatedAt).toBeTruthy();
    expect(body.client.previousSecretValidUntil).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain(oldHash);
    expect(everything()).not.toContain(body.clientSecret);
  });

  it("rotate needs an active client; disable clears the overlap; enable restores", async () => {
    as(OWNER);
    expect((await rotateRoute.POST(request("POST", {}), ctx())).status).toBe(404);
    await createClient();
    await rotateRoute.POST(request("POST", {}), ctx());
    expect((await clientRoute.PATCH(request("PATCH", { status: "disabled" }), ctx())).status).toBe(200);
    expect(world.clients[0]).toMatchObject({ status: "disabled", previousSecretHash: null, previousSecretExpiresAt: null });
    expect(world.clients[0].disabledAt).toBeInstanceOf(Date);
    expect((await rotateRoute.POST(request("POST", {}), ctx())).status).toBe(409);
    expect((await clientRoute.PATCH(request("PATCH", { status: "active" }), ctx())).status).toBe(200);
    expect(world.clients[0]).toMatchObject({ status: "active", disabledAt: null });
  });

  it("rotate rejects a body", async () => {
    await createClient();
    expect((await rotateRoute.POST(request("POST", { clientSecret: "mine" }), ctx())).status).toBe(400);
  });

  it("audits create, update, rotate, disable and enable with ids and reason codes only", async () => {
    await createClient();
    await clientRoute.PATCH(request("PATCH", { redirectUris: ["https://other.example/cb"], datasetName: "staging" }), ctx());
    await rotateRoute.POST(request("POST", {}), ctx());
    await clientRoute.PATCH(request("PATCH", { status: "disabled" }), ctx());
    await clientRoute.PATCH(request("PATCH", { status: "active" }), ctx());
    expect(world.auditActions()).toEqual(["oidc.client.create", "oidc.client.update", "oidc.client.rotate", "oidc.client.disable", "oidc.client.enable"]);
    for (const audit of world.audits) {
      expect(audit).toMatchObject({ actorId: OWNER, organizationId: id(2), resourceType: "oidc_client", ipAddress: "203.0.113.9" });
    }
    expect(world.audits[0].details).toMatchObject({ siteId: SITE, datasetName: "production", redirectUriCount: 1 });
    expect(world.audits[1].details).toMatchObject({ changed: "redirect_uris,dataset_name" });
    expect(JSON.stringify(world.audits)).not.toContain("other.example");
  });

  it("a failed audit write fails the request instead of succeeding without a record", async () => {
    await createClient();
    const failing = world.db.auditLog.create;
    world.db.auditLog.create = async () => { throw new Error("audit down"); };
    // The fake has no rollback; the real writes and the audit row share one transaction.
    expect((await rotateRoute.POST(request("POST", {}), ctx())).status).toBe(503);
    expect((await accessRoute.POST(request("POST", { email: TARGET_EMAIL, role: "reader" }), ctx())).status).toBe(503);
    expect((await clientRoute.PATCH(request("PATCH", { status: "disabled" }), ctx())).status).toBe(503);
    world.db.auditLog.create = failing;
  });

  it("client settings from another app are never visible: queries are scoped to the resolved site", async () => {
    world.addClient({ id: id(400), siteId: id(12), organizationId: id(11), clientId: "jc_BBBBBBBBBBBBBBBBBBBBBB" });
    as(OWNER);
    const body = await json(await clientRoute.GET(request("GET"), ctx()));
    expect(body.client).toBeNull();
  });
});
