import { describe, expect, it, vi } from "vitest";

/**
 * permissions.ts imports its siblings by the "@/lib/..." alias, which vitest
 * does not resolve. Rather than aliasing repo-wide — which would make a mock in
 * another suite start biting and break it — each specifier is mapped here:
 * roles to the real module, because getPermissions genuinely uses it, and the
 * two data-access modules to stubs, because the pure function under test never
 * touches them.
 */
vi.mock("@/lib/roles", async () => await import("./roles"));
vi.mock("@/lib/db", () => ({ getDb: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/repositories", () => ({ isClientAdmin: vi.fn().mockResolvedValue(false) }));

const { checkIsPlatformAdmin, getPermissions } = await import("./permissions");

describe("getPermissions", () => {
  it("lets a collaborator flush the cache", () => {
    // The reason this capability exists: a flush is non-destructive and is the
    // first thing anyone debugging a stale page reaches for.
    expect(getPermissions("collaborator").canFlushCache).toBe(true);
    expect(getPermissions("collaborator").isCollaborator).toBe(true);
  });

  it("lets an admin and the platform admin flush the cache too", () => {
    expect(getPermissions("admin").canFlushCache).toBe(true);
    expect(getPermissions("collaborator", true).canFlushCache).toBe(true);
  });

  it("treats an unknown or missing role as a collaborator that can still flush", () => {
    expect(getPermissions(undefined).canFlushCache).toBe(true);
    expect(getPermissions(null).canFlushCache).toBe(true);
    expect(getPermissions("something-else").canFlushCache).toBe(true);
  });

  it("does not widen anything else in the process", () => {
    const collaborator = getPermissions("collaborator");
    expect(collaborator.isAdmin).toBe(false);
    expect(collaborator.canManageTeam).toBe(false);
    expect(collaborator.canEditDomains).toBe(false);
    expect(collaborator.canViewDiagnostics).toBe(false);
  });

  it("keeps flushing independent of editing domains, which is what it used to borrow", () => {
    // The old gate was canManageDomains, derived from canEditDomains. If those
    // two ever line up again for a collaborator, the admin-only bar is back.
    const collaborator = getPermissions("collaborator");
    expect(collaborator.canFlushCache).toBe(true);
    expect(collaborator.canEditDomains).toBe(false);
  });

  it("still restricts admin-only capabilities to admins", () => {
    const admin = getPermissions("admin");
    expect(admin.canManageTeam).toBe(true);
    expect(admin.canEditDomains).toBe(true);
    expect(admin.canViewDiagnostics).toBe(true);
  });
});

describe("checkIsPlatformAdmin", () => {
  it("matches the bootstrap admin regardless of case or padding", () => {
    expect(checkIsPlatformAdmin(" Admin@Example.com ", "admin@example.com")).toBe(true);
  });

  it("is false when either side is missing, rather than matching empty to empty", () => {
    expect(checkIsPlatformAdmin(null, "admin@example.com")).toBe(false);
    expect(checkIsPlatformAdmin("admin@example.com", null)).toBe(false);
    expect(checkIsPlatformAdmin("", "")).toBe(false);
  });
});
