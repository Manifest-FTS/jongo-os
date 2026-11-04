import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ access: vi.fn() }));
vi.mock("@/lib/tenant-route-access", () => ({ resolveOrganizationAccess: m.access }));

import { destroyLeftover, findLeftovers, restoreLeftover } from "./leftovers";

const SITE = "5f0f997f-b954-4521-944d-8c188f0a07d5";
const deletedSite = { id: SITE, name: "ttttttttt", organizationId: "org-1", coolifyServiceUuid: "qdg1", coolifyProjectId: "proj-a" };

function fakeDb(over: Partial<Record<string, any>> = {}) {
  return {
    site: {
      findMany: vi.fn(async ({ where }: any) =>
        where.deletedAt === null
          ? over.live ?? []
          : over.deleted ?? [{ ...deletedSite, deletedAt: new Date("2026-08-26T18:44:10Z") }]
      ),
      findFirst: vi.fn(async ({ where }: any) => (where.id === SITE && where.deletedAt ? over.target ?? deletedSite : over.liveMatch ?? null)),
      updateMany: vi.fn(async () => ({ count: 1 }))
    },
    auditLog: { create: vi.fn(async () => ({})) },
    $queryRaw: vi.fn(async () => over.links ?? [])
  };
}
const admin = { isAdmin: true, isPlatformAdmin: false, organization: { id: "org-1", coolifyProjectId: "proj-a" } };
const live = (sites: any[]) => async () => ({ mode: "live", sites });

beforeEach(() => {
  vi.clearAllMocks();
  m.access.mockResolvedValue(admin);
});

describe("findLeftovers", () => {
  it("finds resources whose app was deleted", async () => {
    const found = await findLeftovers(["qdg1", "other"], { db: fakeDb() });
    expect(found.get("qdg1")).toMatchObject({ siteId: SITE, name: "ttttttttt", organizationId: "org-1" });
    expect(found.has("other")).toBe(false);
  });

  it("never counts a resource a live app still uses", async () => {
    const found = await findLeftovers(["qdg1"], { db: fakeDb({ live: [{ coolifyServiceUuid: "qdg1" }] }) });
    expect(found.size).toBe(0);
  });
});

describe("restoreLeftover", () => {
  it("brings the app back for a client admin, and audits it", async () => {
    const db = fakeDb();
    expect(await restoreLeftover(SITE, "u1", { db })).toMatchObject({ ok: true });
    expect(db.site.updateMany).toHaveBeenCalledWith({ where: { id: SITE, deletedAt: { not: null } }, data: { deletedAt: null } });
    expect(db.auditLog.create).toHaveBeenCalled();
  });

  it("refuses non-admins and resources another app took over", async () => {
    m.access.mockResolvedValue({ ...admin, isAdmin: false });
    expect(await restoreLeftover(SITE, "u1", { db: fakeDb() })).toMatchObject({ ok: false, status: 403 });
    m.access.mockResolvedValue(admin);
    const db = fakeDb({ liveMatch: { id: "another" } });
    expect(await restoreLeftover(SITE, "u1", { db })).toMatchObject({ ok: false, status: 409 });
    expect(db.site.updateMany).not.toHaveBeenCalled();
  });

  it("answers not-found to someone outside the client", async () => {
    m.access.mockResolvedValue(null);
    expect(await restoreLeftover(SITE, "u1", { db: fakeDb() })).toMatchObject({ ok: false, status: 404 });
  });
});

describe("destroyLeftover", () => {
  it("deletes a resource in the client's own hosting project", async () => {
    const destroy = vi.fn(async () => ({ ok: true }));
    const out = await destroyLeftover(SITE, "u1", { db: fakeDb(), overview: live([{ id: "qdg1", deployTargetId: "qdg1", coolifyProjectId: "proj-a", siteType: "service" }]), destroy });
    expect(out).toMatchObject({ ok: true });
    expect(destroy).toHaveBeenCalledWith("qdg1", "service");
  });

  it("refuses a resource outside the client's hosting project, unless a platform admin", async () => {
    const destroy = vi.fn(async () => ({ ok: true }));
    const overview = live([{ id: "qdg1", deployTargetId: "qdg1", coolifyProjectId: "someone-elses" }]);
    expect(await destroyLeftover(SITE, "u1", { db: fakeDb(), overview, destroy })).toMatchObject({ ok: false, status: 409 });
    expect(destroy).not.toHaveBeenCalled();
    m.access.mockResolvedValue({ ...admin, isPlatformAdmin: true });
    expect(await destroyLeftover(SITE, "u1", { db: fakeDb(), overview, destroy })).toMatchObject({ ok: true });
  });

  it("never deletes what a live app uses, or while hosting is unreachable", async () => {
    const destroy = vi.fn(async () => ({ ok: true }));
    const overview = live([{ id: "qdg1", deployTargetId: "qdg1", coolifyProjectId: "proj-a" }]);
    expect(await destroyLeftover(SITE, "u1", { db: fakeDb({ liveMatch: { id: "x" } }), overview, destroy })).toMatchObject({ ok: false, status: 409 });
    expect(await destroyLeftover(SITE, "u1", { db: fakeDb(), overview: async () => ({ mode: "mock", sites: [] }), destroy })).toMatchObject({ ok: false, status: 503 });
    expect(destroy).not.toHaveBeenCalled();
  });

  it("says so when it's already gone", async () => {
    const destroy = vi.fn();
    expect(await destroyLeftover(SITE, "u1", { db: fakeDb(), overview: live([]), destroy })).toMatchObject({ ok: true, message: expect.stringContaining("already gone") });
    expect(destroy).not.toHaveBeenCalled();
  });

  it("reports a hosting refusal without claiming success", async () => {
    const out = await destroyLeftover(SITE, "u1", {
      db: fakeDb(),
      overview: live([{ id: "qdg1", deployTargetId: "qdg1", coolifyProjectId: "proj-a" }]),
      destroy: async () => ({ ok: false, message: "HTTP 500" })
    });
    expect(out).toMatchObject({ ok: false, status: 502 });
  });
});
