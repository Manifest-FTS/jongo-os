import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(), workspace: vi.fn(), user: vi.fn(), getDb: vi.fn(), grant: vi.fn(),
  org: vi.fn(), overview: vi.fn(), redirect: vi.fn(), notFound: vi.fn()
}));
vi.mock("@/lib/auth.config", () => ({ auth: m.auth }));
vi.mock("@/lib/db", () => ({ getDb: m.getDb, db: { organization: { findFirst: m.org } } }));
vi.mock("@/lib/repositories", () => ({ getClientWorkspace: m.workspace }));
vi.mock("@/lib/coolify", () => ({ getCoolifyOverview: m.overview }));
vi.mock("next/navigation", () => ({ redirect: m.redirect, notFound: m.notFound }));
vi.mock("@/components/CoolifyProjectMappingForm", () => ({ default: () => <div>Mapping controls</div> }));
vi.mock("@/components/DeleteClientButton", () => ({ default: () => <div>Delete client</div> }));

import ClientSettingsPage from "../app/(platform)/clients/[clientId]/settings/page";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("React", React);
  vi.stubEnv("BOOTSTRAP_ADMIN_EMAIL", "");
  m.auth.mockResolvedValue({ user: { id: "u", email: "stale@example.test", role: "super_admin" } });
  m.workspace.mockResolvedValue({ id: "client", dbId: "org", name: "Client", linkedCoolifyProjects: [] });
  m.getDb.mockResolvedValue({ user: { findUnique: m.user }, platformAdmin: { findUnique: m.grant } });
  m.user.mockResolvedValue({ id: "u", email: "fresh@example.test", role: "admin", deletedAt: null });
  m.grant.mockResolvedValue(null);
  m.org.mockImplementation(async ({ where }) => where.OR ? null : { id: "org", ownerId: "owner", collaborators: [] });
  m.overview.mockResolvedValue({ projects: [] });
  m.redirect.mockImplementation(() => { throw new Error("redirected"); });
  m.notFound.mockImplementation(() => { throw new Error("not found"); });
});
const render = async () => renderToStaticMarkup(await ClientSettingsPage({ params: Promise.resolve({ clientId: "client" }) }));

describe("existing client settings authority", () => {
  it.each(["admin", "super_admin"])("admits fresh DB global %s with no tenant row", async (role) => {
    m.user.mockResolvedValue({ id: "u", email: "fresh@example.test", role, deletedAt: null });
    expect(await render()).toContain("Mapping controls");
    expect(m.redirect).not.toHaveBeenCalled();
  });

  it("revokes settings immediately on DB demotion despite stale JWT", async () => {
    expect(await render()).toContain("Mapping controls");
    m.user.mockResolvedValue({ id: "u", email: "fresh@example.test", role: "collaborator", deletedAt: null });
    m.overview.mockClear();
    await expect(render()).rejects.toThrow("redirected");
    expect(m.overview).not.toHaveBeenCalled();
  });

  it("tenant admins retain settings but cannot render platform binding controls", async () => {
    m.user.mockResolvedValue({ id: "u", email: "fresh@example.test", role: "collaborator", deletedAt: null });
    m.org.mockResolvedValue({ id: "org", ownerId: "owner", collaborators: [{ role: "admin" }] });
    const html = await render();
    expect(html).toContain("Git sources");
    expect(html).not.toContain("Mapping controls");
    expect(m.overview).not.toHaveBeenCalled();
  });

  it.each([null, { id: "u", role: "super_admin", deletedAt: new Date() }])("denies missing/deleted DB identity %j", async (user) => {
    m.user.mockResolvedValue(user);
    await expect(render()).rejects.toThrow("redirected");
    expect(m.org).not.toHaveBeenCalled();
    expect(m.overview).not.toHaveBeenCalled();
  });

  it("denies site-only access to parent organization settings", async () => {
    m.user.mockResolvedValue({ id: "u", email: "fresh@example.test", role: "collaborator", deletedAt: null });
    await expect(render()).rejects.toThrow("redirected");
    expect(m.org).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      OR: [{ ownerId: "u" }, { collaborators: { some: { userId: "u", deletedAt: null } } }]
    }) }));
  });
});