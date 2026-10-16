import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ session: vi.fn(), getDb: vi.fn(), user: vi.fn() }));
vi.mock("next-auth/next", () => ({ getServerSession: m.session }));
vi.mock("@/lib/db", () => ({ getDb: m.getDb }));
import { auth } from "./auth.config";

describe("session identity refresh", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m.session.mockResolvedValue({ user: { id: "u", email: "old-seed@example.com", role: "super_admin" } });
    m.getDb.mockResolvedValue({ user: { findUnique: m.user } });
  });
  it("replaces stale JWT email with current DB identity and does not propagate role claims", async () => {
    m.user.mockResolvedValue({ id: "u", email: "current@example.com", fullName: "Current", deletedAt: null });
    expect(await auth()).toEqual({ user: { id: "u", email: "current@example.com", name: "Current" } });
  });
  it("invalidates deleted/missing identities and fails closed on DB outage", async () => {
    m.user.mockResolvedValue({ id: "u", email: "old-seed@example.com", deletedAt: new Date() });
    expect(await auth()).toBeNull();
    m.user.mockResolvedValue(null);
    expect(await auth()).toBeNull();
    m.getDb.mockResolvedValue(null);
    expect(await auth()).toBeNull();
    m.getDb.mockRejectedValue(new Error("offline"));
    expect(await auth()).toBeNull();
  });
});