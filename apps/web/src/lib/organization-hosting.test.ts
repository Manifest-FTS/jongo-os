import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureOrganizationHostingProject,
  hostingProjectDescription,
  hostingProjectName,
  isJongoProjectFor
} from "./organization-hosting";

describe("hosting project marker", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  it("matches only the exact client", () => {
    const description = hostingProjectDescription("Acme", A);
    expect(isJongoProjectFor(description, A)).toBe(true);
    expect(isJongoProjectFor(description, A.slice(0, -1))).toBe(false);
    expect(isJongoProjectFor(`${description}x`, A)).toBe(false);
    expect(isJongoProjectFor(null, A)).toBe(false);
  });

  it("keeps names readable and bounded", () => {
    expect(hostingProjectName("  Acme   Corp ")).toBe("Acme Corp");
    expect(hostingProjectName("x".repeat(300))).toHaveLength(100);
    expect(hostingProjectName("   ")).toBe("Jongo client");
  });
});

// Runs against a real Postgres when OPERATIONS_TEST_DATABASE_URL points at a
// disposable database with every migration applied. Coolify is faked.
const url = process.env.OPERATIONS_TEST_DATABASE_URL;
describe.skipIf(!url)("ensureOrganizationHostingProject against Postgres", () => {
  let db: any;
  const USER = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
  let orgId: string;
  let projects: Array<Record<string, unknown>>;
  let n = 0;

  const fakeCoolify = () => ({
    listProjects: vi.fn(async () => projects),
    createProject: vi.fn(async (body: { name: string; description: string }) => {
      await new Promise((resolve) => setTimeout(resolve, 50)); // widen any race
      const uuid = `proj-${++n}`;
      projects.push({ uuid, ...body });
      return { ok: true, status: 201, body: { uuid } };
    })
  });

  beforeAll(async () => {
    const { PrismaClient } = await import("@prisma/client");
    db = new PrismaClient({ datasources: { db: { url } } });
    await db.$executeRawUnsafe(
      `insert into "User"(id,email,"updatedAt") values ('${USER}','hosting-test@example.test',now()) on conflict do nothing`
    );
    // Start clean: clients left by an earlier run hold the same fake project ids.
    await db.$executeRawUnsafe(`delete from "OrganizationCoolifyProjectLink" where "organizationId" in (select id from "Organization" where "ownerId" = '${USER}')`);
    await db.$executeRawUnsafe(`delete from "Organization" where "ownerId" = '${USER}'`);
  });
  afterAll(async () => db?.$disconnect());
  beforeEach(async () => {
    projects = [];
    const org = await db.organization.create({
      data: { slug: `hosting-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: "Acme Corp", ownerId: USER }
    });
    orgId = org.id;
  });

  it("creates one project however many requests arrive at once", async () => {
    const coolify = fakeCoolify();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => ensureOrganizationHostingProject(orgId, { db, ...coolify }))
    );
    expect(coolify.createProject).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => (r.ok ? r.projectUuid : "fail"))).size).toBe(1);
    expect(results.filter((r) => r.ok && r.created)).toHaveLength(1);

    const org = await db.organization.findUnique({ where: { id: orgId } });
    expect(org.coolifyProjectId).toBe("proj-1");
    expect(org.coolifyProjectName).toBe("Acme Corp");
    const links = await db.$queryRawUnsafe(`select "isPrimary" from "OrganizationCoolifyProjectLink" where "organizationId" = '${orgId}'`);
    expect(links).toEqual([{ isPrimary: true }]);
    expect(isJongoProjectFor(projects[0].description, orgId)).toBe(true);
  });

  it("adopts the project an earlier attempt created but never saved", async () => {
    projects.push({ uuid: "orphan-1", name: "Acme Corp", description: hostingProjectDescription("Acme Corp", orgId) });
    const coolify = fakeCoolify();
    const result = await ensureOrganizationHostingProject(orgId, { db, ...coolify });
    expect(result).toEqual({ ok: true, projectUuid: "orphan-1", created: false });
    expect(coolify.createProject).not.toHaveBeenCalled();
  });

  it("never claims another client's project, even with the same name", async () => {
    projects.push({ uuid: "theirs", name: "Acme Corp", description: hostingProjectDescription("Acme Corp", USER) });
    projects.push({ uuid: "admin-made", name: "Acme Corp", description: "" });
    const coolify = fakeCoolify();
    const result = await ensureOrganizationHostingProject(orgId, { db, ...coolify });
    expect(result).toMatchObject({ ok: true, created: true });
    expect(result.ok && ["theirs", "admin-made"].includes(result.projectUuid)).toBe(false);
    expect(coolify.createProject).toHaveBeenCalledTimes(1);
  });

  it("leaves an already linked project alone", async () => {
    await db.organization.update({ where: { id: orgId }, data: { coolifyProjectId: `linked-${orgId}` } });
    const coolify = fakeCoolify();
    expect(await ensureOrganizationHostingProject(orgId, { db, ...coolify })).toEqual({
      ok: true,
      projectUuid: `linked-${orgId}`,
      created: false
    });
    expect(coolify.listProjects).not.toHaveBeenCalled();
  });

  it("reports hosting unavailable without saving anything", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await ensureOrganizationHostingProject(orgId, {
      db,
      listProjects: async () => [],
      createProject: async () => ({ ok: false, status: 500 })
    });
    spy.mockRestore();
    expect(result).toMatchObject({ ok: false, reason: "hosting_unavailable" });
    expect((await db.organization.findUnique({ where: { id: orgId } })).coolifyProjectId).toBeNull();
  });

  it("does nothing for a deleted client", async () => {
    await db.organization.update({ where: { id: orgId }, data: { deletedAt: new Date() } });
    const coolify = fakeCoolify();
    expect(await ensureOrganizationHostingProject(orgId, { db, ...coolify })).toMatchObject({ ok: false, reason: "not_found" });
    expect(coolify.createProject).not.toHaveBeenCalled();
  });
});
