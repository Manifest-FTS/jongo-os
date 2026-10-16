import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(), getDb: vi.fn(), user: vi.fn(), grant: vi.fn(),
  organization: { findFirst: vi.fn(), update: vi.fn() },
  site: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  siteCollaborator: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
  collaborator: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  invitation: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  query: vi.fn(), execute: vi.fn(), audit: vi.fn(), destroy: vi.fn(), overview: vi.fn(), importSites: vi.fn()
}));
vi.mock("@/lib/auth.config", () => ({ auth: m.auth }));
vi.mock("@/lib/db", () => ({ getDb: m.getDb, db: {
  user: { findUnique: m.user },
  organization: m.organization, site: m.site, siteCollaborator: m.siteCollaborator,
  collaborator: m.collaborator, invitation: m.invitation,
  $queryRaw: m.query, $executeRaw: m.execute, auditLog: { create: m.audit }
} }));
vi.mock("@/lib/coolify", () => ({ destroyCoolifyApplication: m.destroy, getCoolifyOverview: m.overview }));
vi.mock("@/lib/coolify-project-import", () => ({ importLinkedCoolifyProjectSites: m.importSites }));
vi.mock("@/lib/email", () => ({ isSmtpConfigured: () => false, sendInviteEmail: vi.fn() }));
vi.mock("@/lib/repositories", () => ({ getClientTeamMembers: vi.fn() }));
vi.mock("@/lib/permissions", () => ({ getPlatformAdminContacts: vi.fn() }));

import * as sites from "../app/api/sites/[siteId]/route";
import * as organizations from "../app/api/organizations/[organizationId]/route";
import { POST as siteInvite } from "../app/api/sites/[siteId]/collaborators/route";
import { POST as orgInvite } from "../app/api/organizations/[organizationId]/collaborators/route";
import { PUT as siteRole, DELETE as siteRemove } from "../app/api/sites/[siteId]/collaborators/[collaboratorId]/route";
import { PUT as orgRole, DELETE as orgRemove } from "../app/api/organizations/[organizationId]/collaborators/[collaboratorId]/route";
import { POST as siteInvitation } from "../app/api/sites/[siteId]/collaborators/invitations/[invitationId]/route";
import { POST as orgInvitation } from "../app/api/organizations/[organizationId]/collaborators/invitations/[invitationId]/route";
import { POST as mapping, GET as readMapping } from "../app/api/organizations/[organizationId]/coolify-mapping/route";

// Evaluate the actual Prisma-shaped predicates instead of returning an allowed
// row unconditionally: this catches accidental OR replacement and scope leaks.
function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
    if (key === "AND") return value.every((part: any) => matches(row, part));
    if (key === "OR") return value.some((part: any) => matches(row, part));
    if (value && typeof value === "object") {
      if ("some" in value) return (row[key] ?? []).some((item: any) => matches(item, value.some));
      if ("not" in value) return row[key] !== value.not;
      return Boolean(row[key] && matches(row[key], value));
    }
    return row[key] === value;
  });
}
function project(row: any, select: any): any {
  if (!row || !select) return row;
  return Object.fromEntries(Object.entries(select).map(([key, value]: [string, any]) => {
    if (value === true) return [key, row[key]];
    const related = row[key];
    return [key, Array.isArray(related)
      ? related.filter((r) => matches(r, value.where)).map((r) => project(r, value.select))
      : project(related, value.select)];
  }));
}
const siteId = "11111111-1111-4111-8111-111111111111";
const otherSiteId = "22222222-2222-4222-8222-222222222222";
const siteParams = { params: Promise.resolve({ siteId }) };
const orgParams = { params: Promise.resolve({ organizationId: "org-a" }) };
const memberParams = { params: Promise.resolve({ siteId, collaboratorId: "member" }) };
const orgMemberParams = { params: Promise.resolve({ organizationId: "org-a", collaboratorId: "member" }) };
const request = (body: unknown = {}, method = "POST") => new Request("https://example.test/api", {
  method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" }
});
let org: any;
let site: any;
let otherSite: any;
let memberships: any[];
let principal: any;
function tenant(role = "admin", scope = "org") {
  principal.role = "collaborator";
  (scope === "org" ? org : site).collaborators = [{ userId: "u", role, deletedAt: null }];
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("BOOTSTRAP_ADMIN_EMAIL", "");
  principal = { id: "u", email: "u@example.test", role: "admin", deletedAt: null };
  m.auth.mockResolvedValue({ user: { id: "u", email: "stale@example.test", role: "super_admin" } });
  m.user.mockImplementation(async ({ where }) => where.id ? principal : { id: "target", email: where.email });
  m.grant.mockResolvedValue(null);
  m.getDb.mockResolvedValue({ user: { findUnique: m.user }, platformAdmin: { findUnique: m.grant } });
  org = { id: "org-a", ownerId: "owner", name: "Client", slug: "client", description: null,
    coolifyProjectId: "project-a", coolifyProjectName: "Project A", deletedAt: null, collaborators: [], _count: { sites: 2 } };
  site = { id: siteId, name: "Site A", slug: "site-a", organizationId: org.id,
    coolifyServiceUuid: "resource-a", coolifyProjectId: "project-a", deletedAt: null,
    organization: org, collaborators: [] };
  otherSite = { ...site, id: otherSiteId, slug: "site-b", coolifyServiceUuid: "resource-b",
    organizationId: "org-b", organization: { ...org, id: "org-b", collaborators: [] }, collaborators: [] };
  memberships = [{ id: "member", siteId, userId: "target", role: "collaborator" }];
  m.organization.findFirst.mockImplementation(async ({ where, select }) => matches(org, where) ? project(org, select) : null);
  m.site.findFirst.mockImplementation(async ({ where, select }) => project([site, otherSite].find((r) => matches(r, where)), select) ?? null);
  m.site.update.mockImplementation(async ({ where, data }) => ({ ...site, ...data, id: where.id }));
  m.organization.update.mockImplementation(async ({ data }) => ({ ...org, ...data }));
  m.siteCollaborator.findFirst.mockImplementation(async ({ where }) => memberships.find((r) => matches(r, where)) ?? null);
  m.siteCollaborator.deleteMany.mockImplementation(async ({ where }) => {
    const removed = memberships.filter((r) => matches(r, where));
    memberships = memberships.filter((r) => !matches(r, where));
    return { count: removed.length };
  });
  m.siteCollaborator.update.mockImplementation(async ({ where, data }) => ({ ...where, ...data }));
  m.collaborator.findFirst.mockResolvedValue(null);
  m.collaborator.update.mockImplementation(async ({ where, data }) => ({ ...where, ...data }));
  for (const model of [m.collaborator, m.siteCollaborator]) {
    model.create.mockImplementation(async ({ data }) => ({ ...data, id: "new", user: { email: "target@example.test", fullName: "Target" } }));
  }
  m.invitation.findFirst.mockResolvedValue({ id: "invite", role: "collaborator", acceptedAt: null, revokedAt: null, expiresAt: new Date("2099-01-01") });
  m.query.mockResolvedValue([{ organizationId: "org-a" }]);
  m.overview.mockResolvedValue({ mode: "live", sites: [{ deployTargetId: "resource-a", coolifyProjectId: "project-a" }] });
  m.destroy.mockResolvedValue({ ok: true });
});

describe("existing technical settings routes", () => {
  it("global admins can read existing org/site DTOs without financial fields", async () => {
    org.billingExempt = true;
    org.billingDriver = "native_stripe";
    const orgResponse = await organizations.GET(new Request("https://example.test"), orgParams);
    const siteResponse = await sites.GET(new Request("https://example.test"), siteParams);
    expect(orgResponse.status).toBe(200);
    expect(siteResponse.status).toBe(200);
    for (const response of [orgResponse, siteResponse]) {
      expect(JSON.stringify(await response.json())).not.toMatch(/billingExempt|billingDriver|native_stripe/);
    }
  });

  it.each(["admin", "super_admin"])("fresh global %s updates org and site without membership", async (role) => {
    principal.role = role;
    for (const handler of [sites.PUT, sites.PATCH]) expect((await handler(request({ name: "Renamed" }), siteParams)).status).toBe(200);
    for (const handler of [organizations.PUT, organizations.PATCH]) expect((await handler(request({ name: "Renamed" }), orgParams)).status).toBe(200);
    expect(m.site.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: siteId }, data: { name: "Renamed", slug: "renamed" } }));
  });

  it.each(["bootstrap", "grant"])("retains the %s technical override by fresh identity", async (kind) => {
    principal.role = "collaborator";
    if (kind === "bootstrap") vi.stubEnv("BOOTSTRAP_ADMIN_EMAIL", principal.email);
    else m.grant.mockResolvedValue({ id: "grant" });
    expect((await sites.PATCH(request({ name: "Allowed" }), siteParams)).status).toBe(200);
    expect((await organizations.PATCH(request({ name: "Allowed" }), orgParams)).status).toBe(200);
  });

  it("honors immediate demotion, ignoring a stale super JWT", async () => {
    expect((await sites.PATCH(request({ name: "Allowed" }), siteParams)).status).toBe(200);
    principal.role = "collaborator";
    expect((await sites.PATCH(request({ name: "Denied" }), siteParams)).status).toBe(404);
    expect((await organizations.PATCH(request({ name: "Denied" }), orgParams)).status).toBe(404);
    expect(m.site.update).toHaveBeenCalledTimes(1);
    expect(m.organization.update).not.toHaveBeenCalled();
  });

  it.each(["missing", "deleted", "db unavailable", "schema failure"])("fails closed for %s identity", async (kind) => {
    tenant();
    if (kind === "missing") principal = null;
    if (kind === "deleted") principal.deletedAt = new Date();
    if (kind === "db unavailable") m.getDb.mockResolvedValue(null);
    if (kind === "schema failure") m.user.mockRejectedValue(new Error("role column missing"));
    expect((await sites.PATCH(request({ name: "No" }), siteParams)).status).toBe(404);
    expect((await organizations.PATCH(request({ name: "No" }), orgParams)).status).toBe(404);
    expect(m.site.update).not.toHaveBeenCalled();
  });

  it("site-only admin can edit that site but cannot edit the org or another site", async () => {
    tenant("admin", "site");
    expect((await sites.PATCH(request({ name: "Allowed" }), siteParams)).status).toBe(200);
    expect((await organizations.PATCH(request({ name: "Denied" }), orgParams)).status).toBe(404);
    expect((await sites.PATCH(request({ name: "Denied" }), { params: Promise.resolve({ siteId: otherSiteId }) })).status).toBe(404);
  });

  it.each(["org", "site"])("%s collaborator can only change temporary-domain settings", async (scope) => {
    tenant("collaborator", scope);
    expect((await sites.PATCH(request({ temporaryDomainSlug: "preview" }), siteParams)).status).toBe(200);
    expect((await sites.PATCH(request({ name: "No" }), siteParams)).status).toBe(403);
    expect((await sites.DELETE(request(), siteParams)).status).toBe(403);
  });

  it.each(["org", "site"])("ignores revoked %s admin membership", async (scope) => {
    tenant("admin", scope);
    (scope === "org" ? org : site).collaborators[0].deletedAt = new Date();
    expect((await sites.PATCH(request({ name: "No" }), siteParams)).status).toBe(404);
  });

  it("denies a revoked admin role when a live collaborator grant remains", async () => {
    tenant("collaborator", "site");
    org.collaborators = [{ userId: "u", role: "admin", deletedAt: new Date() }];
    expect((await sites.PATCH(request({ name: "No" }), siteParams)).status).toBe(403);
  });

  it.each(["site", "org"])("denies archived %s even to global admins", async (kind) => {
    (kind === "site" ? site : org).deletedAt = new Date();
    expect((await sites.PATCH(request({ name: "No" }), siteParams)).status).toBe(404);
  });

  it("global admins can archive orgs; tenant admins still cannot delete the org", async () => {
    expect((await organizations.DELETE(request(), orgParams)).status).toBe(200);
    tenant();
    expect((await organizations.DELETE(request(), orgParams)).status).toBe(403);
    org.ownerId = "u";
    expect((await organizations.DELETE(request(), orgParams)).status).toBe(200);
  });

  it("rejects anonymous settings calls", async () => {
    m.auth.mockResolvedValue(null);
    expect((await sites.PATCH(request(), siteParams)).status).toBe(401);
    expect((await organizations.PATCH(request(), orgParams)).status).toBe(401);
  });

  it.each(["billingExempt", "billingDriver", "stripeCustomerId", "role"])("rejects %s in both technical settings endpoints", async (field) => {
    expect((await sites.PATCH(request({ name: "No", [field]: "super_admin" }), siteParams)).status).toBe(400);
    expect((await organizations.PATCH(request({ name: "No", [field]: "super_admin" }), orgParams)).status).toBe(400);
    expect(m.site.update).not.toHaveBeenCalled();
    expect(m.organization.update).not.toHaveBeenCalled();
  });
});

describe("infrastructure binding and destruction", () => {
  it.each(["owner", "org admin", "site admin"])("%s cannot rebind resources or client projects", async (kind) => {
    tenant("admin", kind === "site admin" ? "site" : "org");
    if (kind === "owner") org.ownerId = "u";
    for (const body of [{ coolifyServiceUuid: "victim" }, { coolifyProjectId: "victim" }, { coolifyServiceUuid: null }]) {
      expect((await sites.PATCH(request(body), siteParams)).status).toBe(403);
    }
    expect((await organizations.PATCH(request({ coolifyProjectId: "victim" }), orgParams)).status).toBe(kind === "site admin" ? 404 : 403);
    expect((await mapping(request({ coolifyProjectId: "victim" }), orgParams)).status).toBe(kind === "site admin" ? 404 : 403);
    expect(m.site.update).not.toHaveBeenCalled();
    expect(m.execute).not.toHaveBeenCalled();
    expect(m.importSites).not.toHaveBeenCalled();
  });

  it("allows platform binding updates without accepting billing", async () => {
    expect((await sites.PATCH(request({ coolifyServiceUuid: "resource-b", coolifyProjectId: "project-b" }), siteParams)).status).toBe(200);
    m.query.mockResolvedValue([]);
    expect((await organizations.PATCH(request({ coolifyProjectId: "project-b" }), orgParams)).status).toBe(200);
    expect((await mapping(request({ coolifyProjectId: "project-b" }), orgParams)).status).toBe(200);
    expect((await readMapping(new Request("https://example.test"), orgParams)).status).toBe(200);
    expect((await mapping(request({ coolifyProjectId: "project-b", billingExempt: true }), orgParams)).status).toBe(400);
  });

  it.each(["org", "site"])("%s admin can destroy a verified client resource", async (scope) => {
    tenant("admin", scope);
    expect((await sites.DELETE(request({ deleteCoolifyResource: true }), siteParams)).status).toBe(200);
    expect(m.destroy).toHaveBeenCalledWith("resource-a");
    expect(m.site.update).toHaveBeenCalledWith({ where: { id: siteId }, data: { deletedAt: expect.any(Date) } });
  });

  it.each(["project mismatch", "unowned project", "shared project", "duplicate resource", "same-client duplicate resource", "missing resource", "mock inventory", "inventory error", "missing project"])("refuses %s even with force", async (kind) => {
    tenant();
    if (kind === "project mismatch") m.overview.mockResolvedValue({ mode: "live", sites: [{ deployTargetId: "resource-a", coolifyProjectId: "victim" }] });
    if (kind === "unowned project") m.query.mockResolvedValue([{ organizationId: "victim" }]);
    if (kind === "shared project") m.query.mockResolvedValue([{ organizationId: "org-a" }, { organizationId: "victim" }]);
    if (kind === "duplicate resource") otherSite.coolifyServiceUuid = "resource-a";
    if (kind === "same-client duplicate resource") {
      otherSite.coolifyServiceUuid = "resource-a";
      otherSite.organizationId = "org-a";
      otherSite.organization = org;
    }
    if (kind === "missing resource") m.overview.mockResolvedValue({ mode: "live", sites: [] });
    if (kind === "mock inventory") m.overview.mockResolvedValue({ mode: "mock", sites: [] });
    if (kind === "inventory error") m.overview.mockResolvedValue({ mode: "live", fetchError: "offline", sites: [] });
    if (kind === "missing project") site.coolifyProjectId = null;
    expect((await sites.DELETE(request({ deleteCoolifyResource: true, force: true }), siteParams)).status).toBe(409);
    expect(m.destroy).not.toHaveBeenCalled();
    expect(m.site.update).not.toHaveBeenCalled();
  });

  it("tenant name edits still work after a denied rebind; resource identity is unchanged", async () => {
    tenant();
    expect((await sites.PATCH(request({ name: "Trap", coolifyServiceUuid: "resource-b" }), siteParams)).status).toBe(403);
    expect((await sites.PATCH(request({ name: "Safe" }), siteParams)).status).toBe(200);
    expect((await sites.DELETE(request({ deleteCoolifyResource: true }), siteParams)).status).toBe(200);
    expect(m.destroy).toHaveBeenCalledWith("resource-a");
  });

  it("provider failure retains the site unless explicitly forced after valid binding", async () => {
    tenant();
    m.destroy.mockResolvedValue({ ok: false, message: "unavailable" });
    expect((await sites.DELETE(request({ deleteCoolifyResource: true }), siteParams)).status).toBe(502);
    expect(m.site.update).not.toHaveBeenCalled();
    expect((await sites.DELETE(request({ deleteCoolifyResource: true, force: true }), siteParams)).status).toBe(200);
  });

  it("archive-only never calls the provider; platform destruction honors platform authority", async () => {
    tenant();
    expect((await sites.DELETE(request(), siteParams)).status).toBe(200);
    expect(m.destroy).not.toHaveBeenCalled();
    principal.role = "super_admin";
    expect((await sites.DELETE(request({ deleteCoolifyResource: true }), siteParams)).status).toBe(200);
  });
});

describe("collaborator mutation boundaries", () => {
  const mutations = [
    (body: any) => siteInvite(request(body), siteParams),
    (body: any) => orgInvite(request(body), orgParams),
    (body: any) => siteRole(request(body), memberParams),
    (body: any) => orgRole(request(body), orgMemberParams)
  ];
  it.each(["super_admin", null, "unknown", "owner", "ADMIN", " admin ", 42, {}, false, undefined])("rejects raw role %j before writes", async (role) => {
    for (const [index, mutate] of mutations.entries()) {
      const response = await mutate(index < 2 ? { email: "target@example.test", role } : { role });
      expect(response.status).toBe(400);
    }
    for (const spy of [m.collaborator.create, m.collaborator.update, m.siteCollaborator.create, m.siteCollaborator.update, m.invitation.create, m.invitation.update]) expect(spy).not.toHaveBeenCalled();
  });

  it.each(["admin", "collaborator"])("accepts canonical %s on all four routes", async (role) => {
    m.collaborator.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "member", organizationId: "org-a" });
    memberships = [];
    expect((await mutations[0]({ email: "target@example.test", role })).status).toBe(201);
    expect((await mutations[1]({ email: "target@example.test", role })).status).toBe(201);
    memberships = [{ id: "member", siteId, userId: "target" }];
    expect((await mutations[2]({ role })).status).toBe(200);
    expect((await mutations[3]({ role })).status).toBe(200);
    expect(m.siteCollaborator.update).toHaveBeenCalledWith({ where: { id: "member", siteId }, data: { role } });
    expect(m.collaborator.update).toHaveBeenCalledWith({ where: { id: "member", organizationId: "org-a" }, data: { role } });
  });

  it("rejects financial/global extras on membership mutation bodies", async () => {
    for (const [index, mutate] of mutations.entries()) {
      expect((await mutate({ role: "admin", billingExempt: true, ...(index < 2 ? { email: "target@example.test" } : {}) })).status).toBe(400);
    }
  });

  it("rejects non-object membership payloads and unauthenticated callers", async () => {
    for (const mutate of mutations) {
      expect((await mutate(null)).status).toBe(400);
      expect((await mutate([])).status).toBe(400);
    }
    m.auth.mockResolvedValue(null);
    for (const mutate of mutations) expect((await mutate({ role: "admin" })).status).toBe(401);
    expect((await siteRemove(request(), memberParams)).status).toBe(401);
    expect((await orgRemove(request(), orgMemberParams)).status).toBe(401);
  });

  it("fresh principal failures deny all collaborator mutations before writing", async () => {
    principal.deletedAt = new Date();
    for (const [index, mutate] of mutations.entries()) {
      expect((await mutate({ role: "admin", ...(index < 2 ? { email: "target@example.test" } : {}) })).status).toBe(404);
    }
    expect((await siteRemove(request(), memberParams)).status).toBe(404);
    expect((await orgRemove(request(), orgMemberParams)).status).toBe(404);
    expect(m.siteCollaborator.deleteMany).not.toHaveBeenCalled();
    expect(m.collaborator.create).not.toHaveBeenCalled();
  });

  it("cannot delete another site's collaborator by guessing the membership id", async () => {
    tenant();
    memberships[0].siteId = otherSiteId;
    expect((await siteRemove(request(), memberParams)).status).toBe(404);
    expect(memberships).toHaveLength(1);
    expect(m.siteCollaborator.deleteMany).toHaveBeenCalledWith({ where: { id: "member", siteId } });
  });

  it("deletes the authorized site membership and reports not-found on retry", async () => {
    tenant("admin", "site");
    expect((await siteRemove(request(), memberParams)).status).toBe(200);
    expect(memberships).toHaveLength(0);
    expect((await siteRemove(request(), memberParams)).status).toBe(404);
  });

  it("site-only admin can mutate site roles/invites, not org roles/invites", async () => {
    tenant("admin", "site");
    expect((await siteRole(request({ role: "admin" }), memberParams)).status).toBe(200);
    memberships = [];
    expect((await siteInvite(request({ email: "target@example.test", role: "admin" }), siteParams)).status).toBe(201);
    expect((await orgRole(request({ role: "admin" }), orgMemberParams)).status).toBe(404);
    expect((await orgInvite(request({ email: "target@example.test", role: "admin" }), orgParams)).status).toBe(404);
    expect((await orgRemove(request(), orgMemberParams)).status).toBe(404);
  });

  it("ordinary collaborator cannot promote roles or remove members", async () => {
    tenant("collaborator", "site");
    expect((await siteRole(request({ role: "admin" }), memberParams)).status).toBe(403);
    expect((await siteRemove(request(), memberParams)).status).toBe(403);
    expect((await siteInvite(request({ email: "target@example.test", role: "admin" }), siteParams)).status).toBe(403);
    expect(m.siteCollaborator.deleteMany).not.toHaveBeenCalled();
  });

  it("global invitation mutation uses the authorized site/org scope", async () => {
    const siteContext = { params: Promise.resolve({ siteId, invitationId: "invite" }) };
    const orgContext = { params: Promise.resolve({ organizationId: "org-a", invitationId: "invite" }) };
    expect((await siteInvitation(request({ action: "revoke" }), siteContext)).status).toBe(200);
    expect(m.invitation.findFirst).toHaveBeenCalledWith({ where: { id: "invite", siteId, inviteType: "site" } });
    expect((await orgInvitation(request({ action: "revoke" }), orgContext)).status).toBe(200);
    expect(m.invitation.findFirst).toHaveBeenCalledWith({ where: { id: "invite", organizationId: "org-a", inviteType: "organization" } });
    principal.role = "collaborator";
    expect((await siteInvitation(request({ action: "revoke" }), siteContext)).status).toBe(404);
    expect((await orgInvitation(request({ action: "revoke" }), orgContext)).status).toBe(404);
  });
});