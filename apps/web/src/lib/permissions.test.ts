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
  const admin = getPermissions("admin");
  const collaborator = getPermissions("collaborator");

  it("lets a collaborator do the additive and reversible things", () => {
    // Each of these either adds something or undoes cleanly, so withholding it
    // just means the person who spotted the problem has to go find an admin.
    expect(collaborator.canCreateBackup).toBe(true);
    expect(collaborator.canAnnotateBackup).toBe(true);
    expect(collaborator.canFlushCache).toBe(true);
    expect(collaborator.canSyncStaging).toBe(true);
    expect(collaborator.canEnablePrivacyMode).toBe(true);
  });

  it("does NOT let a collaborator destroy anything or hand out credentials", () => {
    // The bug this guards: every one of these was true for collaborators, so a
    // collaborator could overwrite production or download the whole site.
    expect(collaborator.canRestoreBackup).toBe(false);
    expect(collaborator.canPromoteStaging).toBe(false);
    expect(collaborator.canDeleteSite).toBe(false);
    expect(collaborator.canDownloadBackup).toBe(false);
    expect(collaborator.canManageSftp).toBe(false);
    expect(collaborator.canManageStagingEnvironment).toBe(false);
    expect(collaborator.canManageBackupSchedule).toBe(false);
    // Turning privacy OFF publishes a site somebody hid on purpose, and a page
    // a crawler has already fetched cannot be un-indexed on demand.
    expect(collaborator.canDisablePrivacyMode).toBe(false);
    // Rotating credentials cuts off whoever is already using them.
    expect(collaborator.canManagePrivacyCredentials).toBe(false);
    expect(collaborator.canManageTeam).toBe(false);
    expect(collaborator.canEditDomains).toBe(false);
    expect(collaborator.canViewDiagnostics).toBe(false);
  });

  it("lets a collaborator raise protection but never lower it", () => {
    // The asymmetry is the point: the two directions of one switch are not
    // equally safe, so they are not one permission.
    expect(collaborator.canEnablePrivacyMode).toBe(true);
    expect(collaborator.canDisablePrivacyMode).toBe(false);
    expect(admin.canEnablePrivacyMode).toBe(true);
    expect(admin.canDisablePrivacyMode).toBe(true);
  });

  it("gives an admin everything", () => {
    for (const [name, value] of Object.entries(admin)) {
      if (name === "isCollaborator") continue;
      if (name === "isPlatformAdmin") continue;
      expect(value, `admin should have ${name}`).toBe(true);
    }
  });

  it("treats the platform admin as an admin regardless of role", () => {
    const platform = getPermissions("collaborator", true);
    expect(platform.isAdmin).toBe(true);
    expect(platform.canRestoreBackup).toBe(true);
    expect(platform.canDeleteSite).toBe(true);
  });

  it("treats an unknown or missing role as a collaborator, never as an admin", () => {
    // Failing open here would hand a destructive capability to anyone whose
    // role could not be read.
    for (const role of [undefined, null, "", "something-else", 42, {}]) {
      const p = getPermissions(role as unknown);
      expect(p.isAdmin, `role ${String(role)} must not be admin`).toBe(false);
      expect(p.canRestoreBackup).toBe(false);
      expect(p.canDeleteSite).toBe(false);
    }
  });

  it("keeps every destructive capability strictly tied to isAdmin", () => {
    // A blanket check, so a capability added later cannot quietly default to
    // "everyone" the way canManageBackups did.
    const destructive = [
      "canRestoreBackup",
      "canDownloadBackup",
      "canManageBackupSchedule",
      "canManageSftp",
      "canPromoteStaging",
      "canManageStagingEnvironment",
      "canDisablePrivacyMode",
      "canManagePrivacyCredentials",
      "canEditDomains",
      "canDeleteSite",
      "canManageTeam",
      "canViewDiagnostics"
    ] as const;
    for (const cap of destructive) {
      expect(admin[cap], `admin ${cap}`).toBe(true);
      expect(collaborator[cap], `collaborator ${cap}`).toBe(false);
    }
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
