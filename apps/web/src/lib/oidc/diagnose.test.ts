import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs operator script, no type declarations
import { diagnose } from "../../../../../scripts/oidc-diagnose.mjs";

const ORG = "00000000-0000-4000-8000-000000000001";
const SITE = "00000000-0000-4000-8000-000000000002";
const USER = "00000000-0000-4000-8000-000000000003";
const URI = "https://golflab.example/craft/auth/callback";
const ENV = { JONGO_OIDC_ENABLED: "true", JONGO_CMS_ENABLED: "true", JONGO_OIDC_ISSUER: "x", JONGO_OIDC_SIGNING_KEY: "x", JONGO_OIDC_SIGNING_KID: "x", NEXTAUTH_SECRET: "x" };

function fakePrisma(over: { client?: unknown; user?: unknown; platformAdmin?: unknown } = {}) {
  return {
    oidcClient: { findFirst: async () => ("client" in over ? over.client : { id: "c", clientId: "jc_x", siteId: SITE, organizationId: ORG, status: "active", datasetName: "production", redirectUris: [URI], allowedOrigins: [] }) },
    site: { findUnique: async () => ({ id: SITE, deletedAt: null, organization: { id: ORG, ownerId: "owner", deletedAt: null, owner: { id: "owner", deletedAt: null } } }) },
    user: { findFirst: async () => ("user" in over ? over.user : { id: USER, deletedAt: null, emailVerified: true, authProvider: "local" }) },
    platformAdmin: { findUnique: async () => ("platformAdmin" in over ? over.platformAdmin : { id: "p" }) },
    siteCraftAccess: { findFirst: async () => null },
    collaborator: { findFirst: async () => null },
    auditLog: { findMany: async () => [] }
  };
}
const failures = (rows: Array<{ ok: boolean; name: string }>) => rows.filter((row) => !row.ok).map((row) => row.name);
const args = { email: "a@b.co", clientId: "jc_x", redirectUri: URI, dataset: "production" };

describe("scripts/oidc-diagnose.mjs", () => {
  it("passes when everything lines up", async () => {
    expect(failures(await diagnose(fakePrisma(), args, ENV))).toEqual([]);
  });

  it("names a disabled CMS flag, even for a platform admin", async () => {
    const rows = await diagnose(fakePrisma(), args, { ...ENV, JONGO_CMS_ENABLED: "" });
    expect(failures(rows)).toEqual([expect.stringContaining("JONGO_CMS_ENABLED")]);
  });

  it("names an unverified email, a wrong redirect URI and a dataset mismatch", async () => {
    const rows = await diagnose(fakePrisma({ user: { id: USER, deletedAt: null, emailVerified: false, authProvider: "local" } }), { ...args, redirectUri: `${URI}/`, dataset: "staging" }, ENV);
    expect(failures(rows).map((name) => name.slice(0, 22))).toEqual(["the site's redirect UR", "client dataset name eq", "the Jongo account's em"]);
  });

  it("stops with a clear failure when no client is registered", async () => {
    const rows = await diagnose(fakePrisma({ client: null }), args, ENV);
    expect(failures(rows)).toEqual(["a registered client exists for the app"]);
  });

  it("flags a person with no route to Craft access", async () => {
    expect(failures(await diagnose(fakePrisma({ platformAdmin: null }), args, ENV))).toEqual(["the person has some Craft access to this app"]);
  });

  it("never prints secrets or values", async () => {
    const text = JSON.stringify(await diagnose(fakePrisma(), args, { ...ENV, NEXTAUTH_SECRET: "super-secret-value" }));
    expect(text).not.toContain("super-secret-value");
  });
});
