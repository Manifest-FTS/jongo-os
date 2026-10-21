import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ auth: vi.fn(), getDb: vi.fn(), user: vi.fn(), organizations: vi.fn() }));
vi.mock("@/lib/auth.config", () => ({ auth: m.auth }));
vi.mock("@/lib/db", () => ({ getDb: m.getDb }));
import { GET } from "./route";

const request = (query = "") => new Request(`https://example.test/api/workspaces${query}`);
beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ user: { id: "session-actor", role: "super_admin" } });
  m.getDb.mockResolvedValue({ user: { findFirst: m.user }, organization: { findMany: m.organizations } });
  m.user.mockResolvedValue({ id: "session-actor" });
  m.organizations.mockResolvedValue([{
    id: "org-id", name: "Acme", slug: "acme", owner: {
      deletedAt: null, subscriptionPlanId: "pro", subscriptionStatus: "active", subscriptionCurrentPeriodEnd: new Date("2099-01-01"),
      stripeCustomerId: "secret", billingNotes: "private"
    }
  }]);
});

describe("authenticated workspace endpoint", () => {
  it("returns only DTOs using session identity, ignores supplied identity/scope, and disables caching", async () => {
    const response = await GET(request("?userId=other&role=super_admin&organizationId=other"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [{ id: "org-id", name: "Acme", slug: "acme", planLabel: "Pro" }], hasMore: false, nextCursor: null });
    expect(m.user.mock.calls[0][0].where).toEqual({ id: "session-actor", deletedAt: null });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
  });
  it.each([null, { user: { email: "bootstrap@example.test" } }])("requires session user ID", async (session) => {
    m.auth.mockResolvedValue(session);
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(m.getDb).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
  });
  it("rejects a deleted authenticated user", async () => {
    m.user.mockResolvedValue(null);
    expect((await GET(request())).status).toBe(401);
    expect(m.organizations).not.toHaveBeenCalled();
  });
  it.each(["?limit=101", "?limit=", "?limit=nope", "?search=" + "a".repeat(101), "?cursor=bad!"])("rejects invalid %s", async (query) => {
    const response = await GET(request(query));
    expect(response.status).toBe(400);
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(m.organizations).not.toHaveBeenCalled();
  });
  it("returns safe no-store errors, never raw DB/provider details", async () => {
    m.organizations.mockRejectedValue(new Error("stripe secret database query"));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Workspaces are temporarily unavailable." });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
  });
  it("adds no public middleware exemption", () => {
    const middleware = readFileSync(new URL("../../../middleware.ts", import.meta.url), "utf8");
    expect(middleware).not.toContain("/api/workspaces");
  });
});