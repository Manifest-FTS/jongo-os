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
vi.mock("@/lib/permissions", () => ({ getPlatformAdminContacts: async () => [] }));
vi.mock("@/lib/email", () => ({ isSmtpConfigured: () => false, sendInviteEmail: vi.fn(), sendInviteAcceptedEmail: vi.fn() }));
vi.mock("@/lib/repositories", () => ({ getClientTeamMembers: async () => [] }));

import { GET as listCollaborators, POST as inviteToSite } from "@/app/api/sites/[siteId]/collaborators/route";
import { POST as manageInvitation } from "@/app/api/sites/[siteId]/collaborators/invitations/[invitationId]/route";
import { POST as acceptInvite } from "@/app/api/invites/[token]/accept/route";
import { createInviteTokenForInvitation } from "@/lib/invitations";
import { resolveCraftAccess } from "@/lib/craft-access";
import { applyInviteCraftAccess } from "@/lib/craft-admin/access";
import { CraftWorld, ORG, ORG_ADMIN, ORG_COLLAB, OWNER, SITE, SITE_ADMIN, STRANGER, SUPER, TARGET, TARGET_EMAIL } from "./testing";

let world: CraftWorld;
const ctx = { params: Promise.resolve({ siteId: SITE }) };
const as = (userId: string | null) => mocks.auth.mockResolvedValue(userId ? { user: { id: userId, email: world.users.get(userId)?.email } } : null);
const post = (body: unknown) => new Request("https://jongo.example/api/x", {
  method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7", "user-agent": "vitest" }
});
const json = async (response: Response) => JSON.parse(await response.text());
const NEW_EMAIL = "newcomer@example.com";

function enable() {
  vi.stubEnv("JONGO_OIDC_ENABLED", "true");
  vi.stubEnv("JONGO_CMS_ENABLED", "true");
  vi.stubEnv("NEXTAUTH_SECRET", "a-real-test-secret");
}

beforeEach(() => {
  vi.resetAllMocks();
  world = new CraftWorld();
  mocks.world.current = world;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  enable();
});
afterEach(() => vi.unstubAllEnvs());

describe("inviting to an app with a Craft role", () => {
  it.each([["owner", OWNER], ["client admin", ORG_ADMIN], ["platform super admin", SUPER]])("%s: the role is stored on the invite, audited and shown in the list", async (_label, actor) => {
    as(actor);
    const response = await inviteToSite(post({ email: NEW_EMAIL, role: "collaborator", craftRole: "publisher" }), ctx);
    expect(response.status).toBe(202);
    const created = await json(response);
    expect(created).toMatchObject({ status: "pending", craftRole: "publisher" });
    expect(world.inviteRoles.get(created.id)).toBe("publisher");
    expect(world.audits).toEqual([expect.objectContaining({
      action: "craft.access.invite", actorId: actor, organizationId: ORG, resourceId: SITE, details: { invitationId: created.id, role: "publisher", outcome: "created" }
    })]);
    expect(world.grants).toEqual([]);

    const list = await json(await listCollaborators(new Request("https://jongo.example/api/x"), ctx));
    expect(list).toMatchObject({ craftEnabled: true, craftCanGrant: true });
    expect(list.pendingInvites[0]).toMatchObject({ id: created.id, craftRole: "publisher" });
  });

  it("the default (omitted, null or \"none\") stores no Craft role and writes no Craft audit row", async () => {
    as(OWNER);
    for (const extra of [{}, { craftRole: null }, { craftRole: "none" }]) {
      world.invitations.length = 0;
      const created = await json(await inviteToSite(post({ email: NEW_EMAIL, role: "collaborator", ...extra }), ctx));
      expect(created.craftRole).toBeUndefined();
      expect(world.inviteRoles.size).toBe(0);
    }
    expect(world.audits).toEqual([]);
  });

  it.each([["app-level admin", SITE_ADMIN], ["client collaborator", ORG_COLLAB]])("%s cannot attach Craft access: 403 before anything is written", async (_label, actor) => {
    as(actor);
    for (const craftRole of ["reader", "editor", "publisher", "admin"]) {
      const response = await inviteToSite(post({ email: NEW_EMAIL, role: "collaborator", craftRole }), ctx);
      expect(response.status, craftRole).toBe(403);
    }
    expect(world.invitations).toEqual([]);
    expect(world.inviteRoles.size).toBe(0);
    expect(world.grants).toEqual([]);
    expect(world.audits).toEqual([]);
  });

  it("an app-level admin can still invite without Craft access, exactly as before", async () => {
    as(SITE_ADMIN);
    expect((await inviteToSite(post({ email: NEW_EMAIL, role: "collaborator" }), ctx)).status).toBe(202);
    const list = await json(await listCollaborators(new Request("https://jongo.example/api/x"), ctx));
    expect(list).toMatchObject({ craftEnabled: true, craftCanGrant: false });
  });

  it.each(["owner", "super_admin", "Admin", "", 5, {}, ["admin"], true])("rejects craftRole %j with 400 and writes nothing", async (craftRole) => {
    as(OWNER);
    expect((await inviteToSite(post({ email: NEW_EMAIL, role: "collaborator", craftRole }), ctx)).status).toBe(400);
    expect(world.invitations).toEqual([]);
    expect(world.inviteRoles.size).toBe(0);
  });

  it("an existing Jongo user is added immediately and the Craft role applies immediately", async () => {
    as(OWNER);
    const response = await inviteToSite(post({ email: TARGET_EMAIL, role: "collaborator", craftRole: "editor" }), ctx);
    expect(response.status).toBe(201);
    expect(await json(response)).toMatchObject({ status: "active", craftAccess: { role: "editor", applied: true } });
    expect(world.grants[0]).toMatchObject({ userId: TARGET, role: "editor", grantedByUserId: OWNER });
    expect(await resolveCraftAccess(TARGET, SITE)).toMatchObject({ role: "editor", via: "site_grant" });
    expect(world.auditActions()).toEqual(["craft.access.grant"]);
  });

  it("re-inviting an email with a pending invite updates the stored Craft role", async () => {
    as(OWNER);
    const first = await json(await inviteToSite(post({ email: NEW_EMAIL, role: "collaborator", craftRole: "reader" }), ctx));
    const second = await inviteToSite(post({ email: NEW_EMAIL, role: "collaborator", craftRole: "admin" }), ctx);
    expect(second.status).toBe(202);
    expect(world.invitations).toHaveLength(1);
    expect(world.inviteRoles.get(first.id)).toBe("admin");
  });

  it("regenerating carries the role only when a manager does it", async () => {
    as(OWNER);
    const created = await json(await inviteToSite(post({ email: NEW_EMAIL, role: "collaborator", craftRole: "editor" }), ctx));
    const regenerate = (userId: string) => { as(userId); return manageInvitation(post({ action: "regenerate" }), { params: Promise.resolve({ siteId: SITE, invitationId: created.id }) }); };

    const byAdmin = await json(await regenerate(SITE_ADMIN));
    expect(world.inviteRoles.has(byAdmin.id)).toBe(false);

    world.invitations.find((i) => i.id === byAdmin.id)!.revokedAt = new Date();
    world.invitations.find((i) => i.id === created.id)!.revokedAt = null;
    const byOwner = await json(await regenerate(OWNER));
    expect(world.inviteRoles.get(byOwner.id)).toBe("editor");
  });
});

describe("accepting an invite applies the Craft role", () => {
  async function inviteTarget(actor: string, craftRole?: string) {
    as(actor);
    const response = await inviteToSite(post({ email: TARGET_EMAIL, role: "collaborator", forceInvite: true, ...(craftRole ? { craftRole } : {}) }), ctx);
    expect(response.status).toBe(202);
    return json(response);
  }
  const accept = async (invitationId: string, userId: string = TARGET) => {
    as(userId);
    return acceptInvite(post({}), { params: Promise.resolve({ token: createInviteTokenForInvitation(invitationId) }) });
  };

  it("grants the chosen role to the person who accepted, attributed to the inviter, and sign-in resolution sees it", async () => {
    const invite = await inviteTarget(ORG_ADMIN, "publisher");
    expect(await resolveCraftAccess(TARGET, SITE)).toBeNull();
    const response = await accept(invite.id);
    expect(response.status).toBe(200);
    expect(world.siteCollaborators.some((c) => c.userId === TARGET)).toBe(true);
    expect(world.grants).toEqual([expect.objectContaining({ siteId: SITE, userId: TARGET, role: "publisher", grantedByUserId: ORG_ADMIN, revokedAt: null })]);
    expect(await resolveCraftAccess(TARGET, SITE)).toMatchObject({ role: "publisher", via: "site_grant" });
    expect(world.audits.at(-1)).toMatchObject({
      action: "craft.access.grant", actorId: ORG_ADMIN, details: { targetUserId: TARGET, role: "publisher", replaced: false, via: "invite", invitationId: invite.id }
    });
  });

  it("an invite without a Craft role grants none", async () => {
    const invite = await inviteTarget(OWNER);
    expect((await accept(invite.id)).status).toBe(200);
    expect(world.grants).toEqual([]);
    expect(await resolveCraftAccess(TARGET, SITE)).toBeNull();
  });

  it("an inviter demoted before acceptance cannot hand out Craft access: membership is applied, the grant is skipped and audited", async () => {
    const invite = await inviteTarget(ORG_ADMIN, "admin");
    world.orgCollaborators.find((c) => c.userId === ORG_ADMIN)!.role = "collaborator";
    const response = await accept(invite.id);
    expect(response.status).toBe(200);
    expect(world.siteCollaborators.some((c) => c.userId === TARGET)).toBe(true);
    expect(world.grants).toEqual([]);
    expect(world.audits.at(-1)).toMatchObject({
      action: "craft.access.invite", actorId: ORG_ADMIN, details: { invitationId: invite.id, role: "admin", targetUserId: TARGET, outcome: "skipped", reason: "inviter_no_longer_authorized" }
    });
  });

  it("an inviter who was removed (null inviter) grants nothing", async () => {
    const invite = await inviteTarget(OWNER, "editor");
    world.invitations.find((i) => i.id === invite.id)!.invitedById = null;
    expect((await accept(invite.id)).status).toBe(200);
    expect(world.grants).toEqual([]);
  });

  it("with the flag off at acceptance, nothing Craft runs (the table is not even queried) and acceptance is unchanged", async () => {
    const invite = await inviteTarget(OWNER, "editor");
    vi.stubEnv("JONGO_OIDC_ENABLED", "false");
    const before = world.calls.length;
    const response = await accept(invite.id);
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ ok: true, role: "collaborator", inviteType: "site" });
    expect(world.calls.slice(before)).not.toContain("invitationCraftAccess.findUnique");
    expect(world.grants).toEqual([]);
  });

  it("a failure while applying never fails the acceptance", async () => {
    const invite = await inviteTarget(OWNER, "editor");
    world.db.invitationCraftAccess.findUnique = async () => { throw new Error("table missing"); };
    expect((await accept(invite.id)).status).toBe(200);
    expect(world.siteCollaborators.some((c) => c.userId === TARGET)).toBe(true);
  });

  it("applyInviteCraftAccess is inert for organization invites and when disabled", async () => {
    vi.stubEnv("JONGO_OIDC_ENABLED", "false");
    expect(await applyInviteCraftAccess({ id: "i", organizationId: ORG, siteId: SITE, invitedById: OWNER }, TARGET)).toEqual({ status: "disabled" });
    enable();
    expect(await applyInviteCraftAccess({ id: "i", organizationId: ORG, siteId: SITE, invitedById: OWNER }, TARGET)).toEqual({ status: "none" });
  });

  it("an unrelated person cannot piggyback: the grant goes to whoever the server resolved at acceptance, never to a client-supplied id", async () => {
    const invite = await inviteTarget(OWNER, "reader");
    as(STRANGER);
    const response = await acceptInvite(post({ userId: STRANGER, siteId: SITE, role: "admin" }), { params: Promise.resolve({ token: createInviteTokenForInvitation(invite.id) }) });
    // STRANGER's session email does not match the invite email, so they would need the invite email's password.
    expect(response.status).not.toBe(200);
    expect(world.grants).toEqual([]);
  });
});

describe("flag off: the invite endpoints behave exactly as before", () => {
  beforeEach(() => vi.stubEnv("JONGO_OIDC_ENABLED", "false"));

  it("craftRole is an unknown field (400), exactly like any other unexpected key", async () => {
    as(OWNER);
    for (const craftRole of ["editor", null, "none", 5]) {
      const response = await inviteToSite(post({ email: NEW_EMAIL, role: "collaborator", craftRole }), ctx);
      expect(response.status).toBe(400);
      expect(await json(response)).toEqual({ error: "role must be admin or collaborator" });
    }
    expect(world.invitations).toEqual([]);
  });

  it("invites, listings and acceptance never touch the Craft tables or the audit log", async () => {
    as(OWNER);
    const created = await json(await inviteToSite(post({ email: TARGET_EMAIL, role: "collaborator", forceInvite: true }), ctx));
    const list = await json(await listCollaborators(new Request("https://jongo.example/api/x"), ctx));
    expect(Object.keys(list).sort()).toEqual(["callerRole", "clientTeam", "collaborators", "emailDeliveryConfigured", "pendingInvites", "platformAdmins"]);
    expect(list.pendingInvites[0]).not.toHaveProperty("craftRole");
    as(TARGET);
    expect((await acceptInvite(post({}), { params: Promise.resolve({ token: createInviteTokenForInvitation(created.id) }) })).status).toBe(200);
    expect(world.calls).not.toContain("invitationCraftAccess.findUnique");
    expect(world.inviteRoles.size).toBe(0);
    expect(world.grants).toEqual([]);
    expect(world.audits).toEqual([]);
  });
});
