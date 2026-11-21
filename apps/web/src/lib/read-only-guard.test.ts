import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ auth: vi.fn(), principal: vi.fn(), site: vi.fn(), org: vi.fn() }));
vi.mock("@/lib/auth.config", () => ({ auth: m.auth }));
vi.mock("@/lib/rbac", () => ({ resolvePrincipal: m.principal }));
vi.mock("@/lib/db", () => ({ getDb: async () => ({ site: { findFirst: m.site }, organization: { findFirst: m.org } }) }));

import { readOnlyDenial } from "./read-only-guard";
import { getPermissions, isEffectiveViewer } from "./permissions";
import { normalizeRole } from "./roles";

const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });
const siteWith = (orgRole: string | null, siteRole: string | null, ownerId = "owner") => ({
  organization: { ownerId, collaborators: orgRole ? [{ role: orgRole }] : [] },
  collaborators: siteRole ? [{ role: siteRole }] : []
});

beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ user: { id: "u1", email: "u@example.test" } });
  m.principal.mockResolvedValue({ userId: "u1", isPlatformAdmin: false });
});

describe("viewer role", () => {
  it("is its own role now, not an alias for collaborator", () => {
    expect(normalizeRole("viewer")).toBe("viewer");
    expect(normalizeRole("VIEWER")).toBe("viewer");
  });

  it("counts as view-only only when every grant is viewer", () => {
    expect(isEffectiveViewer("viewer", null)).toBe(true);
    expect(isEffectiveViewer(null, "viewer")).toBe(true);
    expect(isEffectiveViewer("viewer", "collaborator")).toBe(false);
    expect(isEffectiveViewer("viewer", "admin")).toBe(false);
    expect(isEffectiveViewer(null, null)).toBe(false);
  });

  it("is never an admin", () => {
    expect(getPermissions("viewer").isAdmin).toBe(false);
  });
});

describe("read-only guard on write routes", () => {
  it("refuses a viewer on an app", async () => {
    m.site.mockResolvedValue(siteWith("viewer", null));
    const res = await readOnlyDenial(ctx({ siteId: "site-1" }));
    expect(res?.status).toBe(403);
    expect((await res!.json()).reason).toBe("read_only");
  });

  it("lets collaborators, admins, owners and platform admins through", async () => {
    m.site.mockResolvedValue(siteWith("collaborator", null));
    expect(await readOnlyDenial(ctx({ siteId: "s" }))).toBeNull();
    m.site.mockResolvedValue(siteWith("viewer", "admin"));
    expect(await readOnlyDenial(ctx({ siteId: "s" }))).toBeNull();
    m.site.mockResolvedValue(siteWith("viewer", null, "u1"));
    expect(await readOnlyDenial(ctx({ siteId: "s" }))).toBeNull();
    m.principal.mockResolvedValue({ userId: "u1", isPlatformAdmin: true });
    m.site.mockResolvedValue(siteWith("viewer", null));
    expect(await readOnlyDenial(ctx({ siteId: "s" }))).toBeNull();
  });

  it("refuses a viewer on a client, looking slugs up by slug", async () => {
    m.org.mockResolvedValue({ ownerId: "owner", collaborators: [{ role: "viewer" }] });
    expect((await readOnlyDenial(ctx({ organizationId: "acme" })))?.status).toBe(403);
    expect(m.org).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ slug: "acme" }) }));
  });

  it("leaves machine callers and unknown resources to the route", async () => {
    m.auth.mockResolvedValue(null);
    expect(await readOnlyDenial(ctx({ siteId: "s" }))).toBeNull();
    m.auth.mockResolvedValue({ user: { id: "u1" } });
    m.site.mockResolvedValue(null);
    expect(await readOnlyDenial(ctx({ siteId: "missing" }))).toBeNull();
    expect(await readOnlyDenial(undefined)).toBeNull();
  });

  it("falls through to the route's own checks if the lookup fails", async () => {
    m.site.mockRejectedValue(new Error("db down"));
    expect(await readOnlyDenial(ctx({ siteId: "s" }))).toBeNull();
  });
});
