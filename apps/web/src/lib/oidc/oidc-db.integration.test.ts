/**
 * Runs ONLY against a throwaway PostgreSQL cluster (see jongo/scripts/test-oidc-db.mjs, which sets
 * OIDC_TEST_DATABASE_URL). Without that variable every test here is skipped, so the normal suite never
 * needs a database. It refuses any URL that is not a loopback host.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

const url = process.env.OIDC_TEST_DATABASE_URL;
const enabled = Boolean(url);
if (url && !/^postgres(?:ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(url)) {
  throw new Error("OIDC_TEST_DATABASE_URL must point at a loopback temporary cluster");
}

const holder = vi.hoisted(() => ({ prisma: null as unknown }));
vi.mock("@/lib/db", () => ({ getDb: async () => holder.prisma }));

import { grantCraftAccess, resolveCraftAccess, revokeCraftAccess } from "@/lib/craft-access";
import { applyInviteCraftAccess, getCraftAccessOverview, loadInviteCraftRoles, rememberInviteCraftRole } from "@/lib/craft-admin/access";
import { createCraftClient, rotateCraftClientSecret, updateCraftClient } from "@/lib/craft-admin/client";
import { processAuthorize, processConsent } from "./authorize";
import { generateClientSecret, hashClientSecret, verifyClientSecret } from "./clients";
import { issueAuthCode, redeemAuthCode } from "./codes";
import { loadOidcKeys, publicJwks } from "./keys";
import { s256Challenge } from "./pkce";
import { testConfig } from "./testing";
import { handleTokenRequest } from "./token-endpoint";
import { verifyIdToken } from "./tokens";
// @ts-expect-error plain .mjs operator script
import { disableClient, registerClient, rotateClientSecret } from "../../../../../scripts/oidc-register-client.mjs";

const ISSUER = "https://jongo.example";
const verifier = "v".repeat(64);
const challenge = s256Challenge(verifier);
const REDIRECT = "https://site.example/craft/auth/callback";
const tag = randomUUID().slice(0, 8);

describe.skipIf(!enabled)("OIDC against a real PostgreSQL cluster", () => {
  let prisma: any;
  let owner: any, member: any, outsider: any, admin: any, platform: any;
  let org: any, site: any, otherSite: any;

  const user = (label: string, extra: Record<string, unknown> = {}) =>
    prisma.user.create({ data: { email: `${label}-${tag}@example.test`, fullName: label, emailVerified: true, ...extra } });

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: url });
    holder.prisma = prisma;
    vi.stubEnv("JONGO_CMS_ENABLED", "true");
    owner = await user("owner", { subscriptionPlanId: "core-sla", subscriptionStatus: "active", subscriptionCurrentPeriodEnd: new Date("2099-01-01") });
    member = await user("member");
    outsider = await user("outsider");
    admin = await user("orgadmin");
    platform = await user("platform");
    await prisma.platformAdmin.create({ data: { userId: platform.id, grantedBy: owner.id } });
    org = await prisma.organization.create({ data: { slug: `org-${tag}`, name: "Org", ownerId: owner.id } });
    site = await prisma.site.create({ data: { organizationId: org.id, slug: `site-${tag}`, name: "Golf Lab" } });
    otherSite = await prisma.site.create({ data: { organizationId: org.id, slug: `other-${tag}`, name: "Other" } });
    await prisma.collaborator.create({ data: { organizationId: org.id, userId: member.id, role: "collaborator" } });
    await prisma.collaborator.create({ data: { organizationId: org.id, userId: admin.id, role: "admin" } });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await prisma?.$disconnect();
  });

  describe("SiteCraftAccess unique active (siteId, userId)", () => {
    it("rejects a second ACTIVE row for the same pair at the database level", async () => {
      await prisma.siteCraftAccess.create({ data: { siteId: site.id, userId: outsider.id, role: "reader" } });
      const duplicate = await prisma.siteCraftAccess.create({ data: { siteId: site.id, userId: outsider.id, role: "admin" } }).catch((e: any) => e);
      expect(duplicate.code).toBe("P2002");
    });

    it("allows history: a revoked row does not block a new active one, and other sites/users are independent", async () => {
      await prisma.siteCraftAccess.updateMany({ where: { siteId: site.id, userId: outsider.id }, data: { revokedAt: new Date() } });
      await prisma.siteCraftAccess.create({ data: { siteId: site.id, userId: outsider.id, role: "editor" } });
      await prisma.siteCraftAccess.create({ data: { siteId: otherSite.id, userId: outsider.id, role: "editor" } });
      await prisma.siteCraftAccess.create({ data: { siteId: site.id, userId: member.id, role: "reader" } });
      const active = await prisma.siteCraftAccess.count({ where: { siteId: site.id, userId: outsider.id, revokedAt: null } });
      const all = await prisma.siteCraftAccess.count({ where: { siteId: site.id, userId: outsider.id } });
      expect([active, all]).toEqual([1, 2]);
    });

    it("grantCraftAccess is race-safe: concurrent grants for one pair leave exactly one active row", async () => {
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
        grantCraftAccess({ actorId: owner.id, siteId: otherSite.id, userId: admin.id, role: i % 2 ? "editor" : "publisher" })));
      expect(results.every((r) => r.ok)).toBe(true);
      expect(await prisma.siteCraftAccess.count({ where: { siteId: otherSite.id, userId: admin.id, revokedAt: null } })).toBe(1);
      expect(results.filter((r) => r.ok && r.created)).toHaveLength(1);
    });

    it("resolves effective roles from the real rows (platform admin, owner, org admin, collaborator with/without grant)", async () => {
      expect(await resolveCraftAccess(platform.id, site.id)).toMatchObject({ role: "admin", via: "platform_admin" });
      expect(await resolveCraftAccess(owner.id, site.id)).toMatchObject({ role: "admin", via: "org_owner" });
      expect(await resolveCraftAccess(admin.id, site.id)).toMatchObject({ role: "admin", via: "org_admin" });
      expect(await resolveCraftAccess(member.id, site.id)).toMatchObject({ role: "reader", via: "site_grant" });
      expect(await resolveCraftAccess(member.id, otherSite.id)).toBeNull();
      expect(await resolveCraftAccess(outsider.id, site.id)).toMatchObject({ role: "editor", via: "site_grant" });
    });

    it("revocation and user/site deletion remove access", async () => {
      expect(await revokeCraftAccess({ actorId: owner.id, siteId: site.id, userId: outsider.id })).toEqual({ ok: true, revoked: true });
      expect(await resolveCraftAccess(outsider.id, site.id)).toBeNull();
      await prisma.user.update({ where: { id: member.id }, data: { deletedAt: new Date() } });
      expect(await resolveCraftAccess(member.id, site.id)).toBeNull();
      await prisma.user.update({ where: { id: member.id }, data: { deletedAt: null } });
      await prisma.site.update({ where: { id: otherSite.id }, data: { deletedAt: new Date() } });
      expect(await resolveCraftAccess(admin.id, otherSite.id)).toBeNull();
      expect(await resolveCraftAccess(platform.id, otherSite.id)).toBeNull();
    });

    it("an inactive owner subscription caps every role to reader (existing entitlement semantics)", async () => {
      await prisma.user.update({ where: { id: owner.id }, data: { subscriptionStatus: "canceled" } });
      expect(await resolveCraftAccess(platform.id, site.id)).toMatchObject({ role: "reader", capped: true });
      expect(await resolveCraftAccess(owner.id, site.id)).toMatchObject({ role: "reader", capped: true });
      await prisma.user.update({ where: { id: owner.id }, data: { subscriptionStatus: "active" } });
    });
  });

  describe("authorization codes", () => {
    let client: any;
    beforeAll(async () => {
      const registered = await registerClient(prisma, { siteId: site.id, name: "Golf Lab Craft", redirectUris: [REDIRECT], createdById: owner.id });
      client = await prisma.oidcClient.findUnique({ where: { clientId: registered.clientId } });
    });

    const issue = (over: Record<string, unknown> = {}) => issueAuthCode(prisma, {
      oidcClientId: client.id, userId: owner.id, redirectUri: REDIRECT, codeChallenge: challenge, nonce: "n", scope: "openid", authTime: new Date(), ...over
    });
    const redeem = (code: string) => redeemAuthCode(prisma, { code, oidcClientId: client.id, redirectUri: REDIRECT, codeVerifier: verifier });

    it("redeems exactly once under 25 concurrent attempts (atomic compare-and-set)", async () => {
      const { code } = await issue();
      const results = await Promise.all(Array.from({ length: 25 }, () => redeem(code)));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok && r.reason === "replay")).toHaveLength(24);
      expect(await prisma.oidcAuthCode.count({ where: { consumedAt: { not: null } } })).toBeGreaterThanOrEqual(1);
    });

    it("stores only the hash and enforces expiry in SQL", async () => {
      const { code } = await issue();
      const rows = await prisma.oidcAuthCode.findMany({});
      expect(JSON.stringify(rows)).not.toContain(code);
      const past = await issue({ now: new Date(Date.now() - 61_000) });
      expect(await redeem(past.code)).toMatchObject({ ok: false, reason: "expired" });
    });

    it("database CHECK constraints reject malformed rows", async () => {
      const base = { oidcClientId: client.id, userId: owner.id, redirectUri: REDIRECT, nonce: "n", scope: "openid", authTime: new Date() };
      const hash = "a".repeat(64);
      await expect(prisma.oidcAuthCode.create({ data: { ...base, codeHash: "not-hex", codeChallenge: challenge, expiresAt: new Date(Date.now() + 60_000) } })).rejects.toThrow();
      await expect(prisma.oidcAuthCode.create({ data: { ...base, codeHash: hash, codeChallenge: "short", expiresAt: new Date(Date.now() + 60_000) } })).rejects.toThrow();
      await expect(prisma.oidcAuthCode.create({ data: { ...base, codeHash: hash, codeChallenge: challenge, expiresAt: new Date(Date.now() + 3_600_000) } })).rejects.toThrow();
      await expect(prisma.oidcAuthCode.create({ data: { ...base, codeHash: hash, codeChallenge: challenge, expiresAt: new Date(Date.now() - 1000) } })).rejects.toThrow();
    });

    it("the composite foreign key refuses a client whose organization does not match the site", async () => {
      const otherOrg = await prisma.organization.create({ data: { slug: `org2-${tag}`, name: "Org2", ownerId: owner.id } });
      await expect(prisma.oidcClient.create({
        data: { clientId: `jc_${"B".repeat(22)}`, organizationId: otherOrg.id, siteId: site.id, name: "x", secretHash: hashClientSecret("s"), redirectUris: [REDIRECT], allowedOrigins: [] }
      })).rejects.toThrow();
    });

    it("rotation keeps the old secret valid for the overlap, disable blocks the client, deleting the client cascades codes", async () => {
      const second = await registerClient(prisma, { siteId: site.id, name: "Second", redirectUris: [REDIRECT] });
      const rotated = await rotateClientSecret(prisma, second.clientId);
      const row = await prisma.oidcClient.findUnique({ where: { clientId: second.clientId } });
      expect(row.previousSecretHash).toBeTruthy();
      expect(row.previousSecretExpiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
      expect(rotated.secret).not.toBe(second.secret);
      await issueAuthCode(prisma, { oidcClientId: row.id, userId: owner.id, redirectUri: REDIRECT, codeChallenge: challenge, nonce: "n", scope: "openid", authTime: new Date() });
      await disableClient(prisma, second.clientId);
      expect((await prisma.oidcClient.findUnique({ where: { clientId: second.clientId } })).status).toBe("disabled");
      await prisma.oidcClient.delete({ where: { id: row.id } });
      expect(await prisma.oidcAuthCode.count({ where: { oidcClientId: row.id } })).toBe(0);
      expect(await prisma.auditLog.count({ where: { organizationId: org.id, action: { in: ["oidc.client.create", "oidc.client.rotate", "oidc.client.disable"] } } })).toBeGreaterThanOrEqual(3);
    });
  });

  describe("end to end: authorize, consent, token", () => {
    it("issues a verifiable ID token with the resolved role, audits platform_admin, and honours revocation between code and token", async () => {
      const secret = generateClientSecret();
      const registered = await registerClient(prisma, { siteId: site.id, name: "E2E", redirectUris: [REDIRECT] });
      await prisma.oidcClient.update({ where: { clientId: registered.clientId }, data: { secretHash: hashClientSecret(secret) } });
      const keys = await loadOidcKeys(testConfig({ issuer: ISSUER }));
      const deps = { db: prisma, resolveAccess: resolveCraftAccess, consentSecret: keys.consentSecret, issuer: ISSUER };
      const params = { client_id: registered.clientId, redirect_uri: REDIRECT, response_type: "code", scope: "openid email profile", state: "s", nonce: "n-e2e", code_challenge: challenge, code_challenge_method: "S256" };

      const exchange = async (code: string) => handleTokenRequest(new Request(`${ISSUER}/api/oidc/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${registered.clientId}:${secret}`).toString("base64")}`, "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 200)}` },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier })
      }), { db: prisma, issuer: ISSUER, keys, resolveAccess: resolveCraftAccess });

      // Platform admin: consent first, then a silent second round.
      const first = await processAuthorize(deps, platform.id, params);
      expect(first.kind).toBe("consent");
      if (first.kind !== "consent") return;
      const issued = await processConsent(deps, platform.id, params, "allow", first.view.consentToken);
      expect(issued.kind).toBe("redirect");
      const again = await processAuthorize(deps, platform.id, params);
      expect(again.kind).toBe("redirect");
      if (again.kind !== "redirect") return;
      const code = new URL(again.location).searchParams.get("code")!;
      const response = await exchange(code);
      expect(response.status).toBe(200);
      const { id_token } = await response.json();
      const claims = await verifyIdToken(id_token, { issuer: ISSUER, audience: registered.clientId, nonce: "n-e2e", jwks: publicJwks(keys) });
      expect(claims).toMatchObject({ sub: platform.id, craft: { dataset: "production", role: "admin", siteId: site.id, via: "platform_admin" } });
      const audits = await prisma.auditLog.findMany({ where: { action: "oidc.token.issue", actorId: platform.id } });
      expect(audits).toHaveLength(1);
      expect(audits[0].details).toMatchObject({ reason: "platform_admin" });
      expect(JSON.stringify(audits)).not.toContain(id_token);
      expect((await exchange(code)).status).toBe(400); // replay

      // Removal between authorization and redemption.
      const next = await processAuthorize(deps, platform.id, params);
      if (next.kind !== "redirect") throw new Error(next.kind);
      await prisma.user.update({ where: { id: platform.id }, data: { deletedAt: new Date() } });
      expect((await exchange(new URL(next.location).searchParams.get("code")!)).status).toBe(400);
      await prisma.user.update({ where: { id: platform.id }, data: { deletedAt: null } });

      // A user with no access at all never gets as far as consent.
      expect((await processAuthorize(deps, outsider.id, params)).kind).toBe("no_access");
    });
  });
});

describe.skipIf(!enabled)("Phase 1b admin services against a real PostgreSQL cluster", () => {
  let prisma: any;
  let owner: any, orgAdmin: any, target: any, target2: any, org: any, app: any;
  const FUTURE = new Date("2099-01-01");

  const make = (label: string, extra: Record<string, unknown> = {}) =>
    prisma.user.create({ data: { email: `${label}-b-${tag}@example.test`, fullName: label, emailVerified: true, ...extra } });
  const invitation = (invitedById: string, label: string) => prisma.invitation.create({
    data: { organizationId: org.id, siteId: app.id, email: `${label}-b-${tag}@example.test`, role: "collaborator", tokenHash: randomUUID(), inviteType: "site", invitedById, expiresAt: FUTURE }
  });

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: url });
    holder.prisma = prisma;
    vi.stubEnv("JONGO_CMS_ENABLED", "true");
    vi.stubEnv("JONGO_OIDC_ENABLED", "true");
    owner = await make("owner", { subscriptionPlanId: "core-sla", subscriptionStatus: "active", subscriptionCurrentPeriodEnd: FUTURE });
    orgAdmin = await make("orgadmin");
    target = await make("target");
    target2 = await make("target2");
    org = await prisma.organization.create({ data: { slug: `org-b-${tag}`, name: "Org B", ownerId: owner.id } });
    app = await prisma.site.create({ data: { organizationId: org.id, slug: `app-b-${tag}`, name: "App B" } });
    await prisma.collaborator.create({ data: { organizationId: org.id, userId: orgAdmin.id, role: "admin" } });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await prisma?.$disconnect();
  });

  describe("OIDC client management", () => {
    const site = () => ({ id: app.id, organizationId: org.id });
    const base = () => ({ actorId: owner.id, site: site(), name: "App Craft", datasetName: "production", redirectUris: [REDIRECT], allowedOrigins: ["https://site.example"], ipAddress: "203.0.113.5", userAgent: "vitest" });

    it("one client per app even under concurrent creates (advisory lock works with $executeRaw)", async () => {
      const results = await Promise.all(Array.from({ length: 6 }, () => createCraftClient(base())));
      const created = results.filter((r) => r.ok);
      expect(created).toHaveLength(1);
      expect(results.filter((r) => !r.ok && r.reason === "conflict")).toHaveLength(5);
      expect(await prisma.oidcClient.count({ where: { siteId: app.id } })).toBe(1);
      const row = await prisma.oidcClient.findFirst({ where: { siteId: app.id } });
      const secret = (created[0] as { secret: string }).secret;
      expect(verifyClientSecret(secret, row.secretHash)).toBe(true);
      expect(row.secretHash).not.toContain(secret);
      expect(row.createdById).toBe(owner.id);
      const audits = await prisma.auditLog.findMany({ where: { action: "oidc.client.create", resourceId: row.id } });
      expect(audits).toHaveLength(1);
      expect(JSON.stringify(audits)).not.toContain(secret);
    });

    it("update, rotate, disable and enable persist and audit; the view never carries a hash", async () => {
      const updated = await updateCraftClient({ actorId: owner.id, site: site(), redirectUris: { redirectUris: ["https://new.example/cb"], allowedOrigins: ["https://new.example"] }, datasetName: "staging" });
      expect(updated).toMatchObject({ ok: true, client: { datasetName: "staging", redirectUris: ["https://new.example/cb"], status: "active" } });
      const before = await prisma.oidcClient.findFirst({ where: { siteId: app.id } });
      const rotated = await rotateCraftClientSecret({ actorId: owner.id, site: site() });
      expect(rotated.ok).toBe(true);
      const after = await prisma.oidcClient.findFirst({ where: { siteId: app.id } });
      expect(after.previousSecretHash).toBe(before.secretHash);
      expect(after.previousSecretExpiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
      expect(after.rotatedAt).toBeInstanceOf(Date);
      expect(JSON.stringify(rotated)).not.toContain(after.secretHash);

      expect(await updateCraftClient({ actorId: owner.id, site: site(), status: "disabled" })).toMatchObject({ ok: true, client: { status: "disabled" } });
      expect(await prisma.oidcClient.findFirst({ where: { siteId: app.id } })).toMatchObject({ status: "disabled", previousSecretHash: null, previousSecretExpiresAt: null });
      expect(await rotateCraftClientSecret({ actorId: owner.id, site: site() })).toMatchObject({ ok: false, reason: "conflict" });
      expect(await updateCraftClient({ actorId: owner.id, site: site(), status: "active" })).toMatchObject({ ok: true, client: { status: "active" } });

      const actions = (await prisma.auditLog.findMany({ where: { organizationId: org.id, action: { startsWith: "oidc.client." } }, orderBy: { createdAt: "asc" } })).map((a: any) => a.action);
      expect(actions).toEqual(["oidc.client.create", "oidc.client.update", "oidc.client.rotate", "oidc.client.disable", "oidc.client.enable"]);
    });

    it("a site of another client can never be addressed with this client's organization id", async () => {
      const stranger = await prisma.organization.create({ data: { slug: `org-c-${tag}`, name: "Org C", ownerId: owner.id } });
      expect(await updateCraftClient({ actorId: owner.id, site: { id: app.id, organizationId: stranger.id }, datasetName: "x" })).toMatchObject({ ok: false, reason: "not_found" });
      expect(await rotateCraftClientSecret({ actorId: owner.id, site: { id: app.id, organizationId: stranger.id } })).toMatchObject({ ok: false, reason: "not_found" });
    });
  });

  describe("invitation Craft role (InvitationCraftAccess)", () => {
    it("Invitation itself gained no column: the Craft role lives in its own table", async () => {
      const columns: Array<{ column_name: string }> = await prisma.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_name = 'Invitation'`;
      expect(columns.map((c) => c.column_name).filter((name) => /craft/i.test(name))).toEqual([]);
      const own: Array<{ column_name: string }> = await prisma.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_name = 'InvitationCraftAccess' ORDER BY 1`;
      expect(own.map((c) => c.column_name)).toEqual(["createdAt", "id", "invitationId", "role"]);
    });

    it("one role per invitation, upsert updates it, bad roles are rejected, deleting the invitation removes it", async () => {
      const invite = await invitation(owner.id, "i1");
      await rememberInviteCraftRole(prisma, invite.id, "reader");
      await rememberInviteCraftRole(prisma, invite.id, "publisher");
      expect(await prisma.invitationCraftAccess.count({ where: { invitationId: invite.id } })).toBe(1);
      expect([...(await loadInviteCraftRoles(prisma, [invite.id, randomUUID()])).entries()]).toEqual([[invite.id, "publisher"]]);
      expect((await prisma.invitationCraftAccess.create({ data: { invitationId: invite.id, role: "admin" } }).catch((e: any) => e)).code).toBe("P2002");
      await expect(prisma.invitationCraftAccess.create({ data: { invitationId: invite.id, role: "owner" } })).rejects.toThrow();
      await prisma.invitation.delete({ where: { id: invite.id } });
      expect(await prisma.invitationCraftAccess.count({ where: { invitationId: invite.id } })).toBe(0);
    });

    it("accepting applies the stored role through grantCraftAccess, attributed to the inviter and audited with provenance", async () => {
      const invite = await invitation(owner.id, "i2");
      await rememberInviteCraftRole(prisma, invite.id, "editor");
      expect(await applyInviteCraftAccess(invite, target.id)).toEqual({ status: "applied", role: "editor" });
      expect(await prisma.siteCraftAccess.findFirst({ where: { siteId: app.id, userId: target.id, revokedAt: null } })).toMatchObject({ role: "editor", grantedByUserId: owner.id });
      expect(await resolveCraftAccess(target.id, app.id)).toMatchObject({ role: "editor", via: "site_grant" });
      const audit = await prisma.auditLog.findFirst({ where: { action: "craft.access.grant", actorId: owner.id, resourceId: app.id } });
      expect(audit.details).toMatchObject({ via: "invite", invitationId: invite.id, role: "editor", targetUserId: target.id });
    });

    it("an inviter demoted before acceptance grants nothing, and the skip is audited", async () => {
      const invite = await invitation(orgAdmin.id, "i3");
      await rememberInviteCraftRole(prisma, invite.id, "admin");
      await prisma.collaborator.update({ where: { organizationId_userId: { organizationId: org.id, userId: orgAdmin.id } }, data: { role: "collaborator" } });
      expect(await applyInviteCraftAccess(invite, target2.id)).toEqual({ status: "skipped", reason: "inviter_no_longer_authorized" });
      expect(await prisma.siteCraftAccess.count({ where: { siteId: app.id, userId: target2.id } })).toBe(0);
      const audit = await prisma.auditLog.findFirst({ where: { action: "craft.access.invite", actorId: orgAdmin.id } });
      expect(audit.details).toMatchObject({ outcome: "skipped", reason: "inviter_no_longer_authorized", invitationId: invite.id });
      await prisma.collaborator.update({ where: { organizationId_userId: { organizationId: org.id, userId: orgAdmin.id } }, data: { role: "admin" } });
    });
  });

  describe("access overview", () => {
    it("lists explicit grants with their grantor, plus owner and client admins as read-only inherited rows", async () => {
      const result = await getCraftAccessOverview(owner.id, { id: app.id, organizationId: org.id });
      if (!result.ok) throw new Error(result.reason);
      expect(result.overview.explicit).toEqual([expect.objectContaining({ userId: target.id, role: "editor", grantedBy: { email: owner.email, name: "owner" } })]);
      expect(result.overview.inherited.map((row) => [row.source, row.userId])).toEqual([["platform_admin", null], ["org_owner", owner.id], ["org_admin", orgAdmin.id]]);
      expect(await getCraftAccessOverview(target.id, { id: app.id, organizationId: org.id })).toEqual({ ok: false, reason: "forbidden" });
    });
  });
});
