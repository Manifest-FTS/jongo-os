import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), superAdmin: vi.fn(), sync: vi.fn() }));
vi.mock("@/lib/auth.config", () => ({ auth: mocks.auth }));
vi.mock("@/lib/rbac", () => ({ isSuperAdminUser: mocks.superAdmin }));
vi.mock("@/lib/domain-sync", () => ({ syncNamecheapDomains: mocks.sync }));
import { POST } from "./route";

describe("Namecheap sync endpoint", () => {
  const request = (authorization?: string) => new Request("http://localhost/api/ops/domains-sync-namecheap", {
    method: "POST", headers: authorization ? { authorization } : {}
  });
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("NAMECHEAP_SYNC_TOKEN", "dedicated-secret");
    mocks.auth.mockResolvedValue(null);
    mocks.superAdmin.mockResolvedValue(false);
    mocks.sync.mockResolvedValue({ ok: true, reason: "completed", imported: 1, errors: [] });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("accepts only the dedicated machine token without requiring a session", async () => {
    const response = await POST(request("Bearer dedicated-secret"));
    expect(response.status).toBe(200);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.superAdmin).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it.each([undefined, "dedicated-secret", "Bearer wrong", "Bearer tiny", "Basic dedicated-secret"])("rejects missing, wrong, malformed and unequal-length credentials", async (header) => {
    const response = await POST(request(header));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.sync).not.toHaveBeenCalled();
  });
  it("does not accept an unset token or shared ops token", async () => {
    vi.stubEnv("NAMECHEAP_SYNC_TOKEN", "");
    vi.stubEnv("OWNERSHIP_SYNC_TOKEN", "shared-token");
    expect((await POST(request("Bearer shared-token"))).status).toBe(401);
  });
  it("allows super_admin sessions using the RBAC helper", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "super-user" } });
    mocks.superAdmin.mockResolvedValue(true);
    expect((await POST(request())).status).toBe(200);
    expect(mocks.superAdmin).toHaveBeenCalledWith("super-user");
  });
  it("denies platform/organization administrators without the super_admin role", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "platform-admin", email: "bootstrap@example.com", isPlatformAdmin: true } });
    expect((await POST(request())).status).toBe(403);
    expect(mocks.sync).not.toHaveBeenCalled();
  });
  it("uses 503 and no-store for partial failures", async () => {
    mocks.sync.mockResolvedValue({ ok: false, reason: "sync_failed", imported: 3, errors: [{ code: "SYNC_FAILED", page: 2 }] });
    const response = await POST(request("Bearer dedicated-secret"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ imported: 3 });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("does not expose unexpected exceptions", async () => {
    mocks.sync.mockRejectedValue(new Error("password=SECRET"));
    const response = await POST(request("Bearer dedicated-secret"));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("SECRET");
  });
});