import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ auth: vi.fn(), getDb: vi.fn(), actor: vi.fn(), target: vi.fn(), grant: vi.fn(), create: vi.fn(), remove: vi.fn(), userUpdate: vi.fn() }));
vi.mock("@/lib/auth.config", () => ({ auth: m.auth }));
vi.mock("@/lib/db", () => ({ getDb: m.getDb }));
import { POST } from "../app/api/platform/admins/route";
import { DELETE } from "../app/api/platform/admins/[id]/route";

describe("technical platform grants cannot promote global roles", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("BOOTSTRAP_ADMIN_EMAIL", "seed@example.com");
    m.auth.mockResolvedValue({ user: { id: "actor", email: "seed@example.com", role: "super_admin" } });
    m.getDb.mockResolvedValue({ user: { findUnique: m.actor, findFirst: m.target, update: m.userUpdate }, platformAdmin: { findUnique: m.grant, create: m.create, deleteMany: m.remove } });
    m.actor.mockResolvedValue({ id: "actor", email: "team@example.com", role: "admin", deletedAt: null });
    m.grant.mockResolvedValue({ id: "technical-grant" });
  });
  afterEach(() => vi.unstubAllEnvs());
  const request = () => new Request("https://example.test/api/platform/admins", { method: "POST", body: JSON.stringify({ email: "team@example.com", role: "super_admin" }) });

  it("denies self-grants/revocation for team-granted or global technical admins despite stale seed JWT", async () => {
    expect((await POST(request())).status).toBe(403);
    const response = await DELETE(request(), { params: Promise.resolve({ id: "technical-grant" }) });
    expect(response.status).toBe(403);
    expect(m.create).not.toHaveBeenCalled();
    expect(m.remove).not.toHaveBeenCalled();
    expect(m.userUpdate).not.toHaveBeenCalled();
  });

  it("seed grant creation ignores injected global role and writes only PlatformAdmin", async () => {
    m.actor.mockResolvedValue({ id: "actor", email: "seed@example.com", role: "collaborator", deletedAt: null });
    m.target.mockResolvedValue({ id: "target", email: "team@example.com", fullName: "Team" });
    m.grant.mockResolvedValue(null);
    m.create.mockResolvedValue({ id: "grant", createdAt: new Date() });
    expect((await POST(request())).status).toBe(200);
    expect(m.create).toHaveBeenCalledWith({ data: { userId: "target", grantedBy: "actor" }, select: { id: true, createdAt: true } });
    expect(m.userUpdate).not.toHaveBeenCalled();
  });
});