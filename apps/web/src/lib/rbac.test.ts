import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), user: vi.fn(), grant: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
import { canManageBilling, canViewBilling, isPlatformAdminUser, isSuperAdminUser, resolvePrincipal } from "./rbac";
import { normalizeRole } from "./roles";
import { isPlatformAdminEmail } from "./permissions";

describe("DB authoritative RBAC", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("BOOTSTRAP_ADMIN_EMAIL", "seed@example.com");
    mocks.getDb.mockResolvedValue({ user: { findUnique: mocks.user, findFirst: mocks.user }, platformAdmin: { findUnique: mocks.grant } });
    mocks.grant.mockResolvedValue(null);
    mocks.user.mockResolvedValue({ id: "u", email: "user@example.com", role: "collaborator", deletedAt: null });
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(["super_admin", "admin", "collaborator", "owner", null])("separates global %s from tenant membership", async (role) => {
    mocks.user.mockResolvedValue({ id: "u", email: "user@example.com", role, deletedAt: null });
    const principal = await resolvePrincipal("u");
    expect(canViewBilling(principal)).toBe(role === "super_admin");
    expect(canManageBilling(principal)).toBe(role === "super_admin");
    expect(principal?.isPlatformAdmin).toBe(role === "super_admin" || role === "admin");
  });

  it("does not interpret injected global roles as membership admin, even with an admin fallback", () => {
    expect(normalizeRole("super_admin")).toBe("collaborator");
    expect(normalizeRole(" SUPER_ADMIN ", "admin")).toBe("collaborator");
    expect(normalizeRole("owner")).toBe("admin");
    expect(normalizeRole("operator")).toBe("collaborator");
    expect(normalizeRole("constructor")).toBe("collaborator");
    expect(normalizeRole("__proto__")).toBe("collaborator");
  });

  it("bootstrap and team platform grants never confer billing", async () => {
    mocks.user.mockResolvedValue({ id: "u", email: "seed@example.com", role: "collaborator", deletedAt: null });
    expect(await isPlatformAdminUser("u")).toBe(true);
    expect(await isSuperAdminUser("u")).toBe(false);
    mocks.user.mockResolvedValue({ id: "u", email: "team@example.com", role: "collaborator", deletedAt: null });
    mocks.grant.mockResolvedValue({ id: "grant" });
    expect(await isPlatformAdminUser("u")).toBe(true);
    expect(await isSuperAdminUser("u")).toBe(false);
  });

  it("reflects promotion/demotion immediately without JWT role trust", async () => {
    mocks.user.mockResolvedValue({ id: "u", email: "user@example.com", role: "super_admin", deletedAt: null });
    expect(await isSuperAdminUser("u")).toBe(true);
    mocks.user.mockResolvedValue({ id: "u", email: "user@example.com", role: "admin", deletedAt: null });
    expect(await isSuperAdminUser("u")).toBe(false);
    expect(await isPlatformAdminEmail("user@example.com")).toBe(true);
  });

  it("rejects missing/deleted users, unavailable DB and schema failures", async () => {
    expect(await resolvePrincipal(null)).toBeNull();
    mocks.user.mockResolvedValue(null);
    expect(await isSuperAdminUser("u")).toBe(false);
    mocks.user.mockResolvedValue({ id: "u", email: "seed@example.com", role: "super_admin", deletedAt: new Date() });
    expect(await isPlatformAdminUser("u")).toBe(false);
    mocks.user.mockRejectedValue(new Error("unknown role column"));
    expect(await resolvePrincipal("u")).toBeNull();
    mocks.getDb.mockResolvedValue(null);
    expect(await isSuperAdminUser("u")).toBe(false);
    expect(await isPlatformAdminEmail("seed@example.com")).toBe(false);
    mocks.getDb.mockRejectedValue(new Error("offline"));
    expect(await resolvePrincipal("u")).toBeNull();
  });
});