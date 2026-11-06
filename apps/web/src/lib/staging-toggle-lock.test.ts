import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  workspace: vi.fn(),
  permissions: vi.fn(),
  siteFindFirst: vi.fn(),
  join: vi.fn(),
  start: vi.fn(),
  succeed: vi.fn(),
  fail: vi.fn()
}));
vi.mock("@/lib/auth.config", () => ({ auth: m.auth }));
vi.mock("@/lib/repositories", () => ({ getSiteWorkspace: m.workspace }));
vi.mock("@/lib/permissions", () => ({ resolveSitePermissionSnapshot: m.permissions }));
vi.mock("@/lib/db", () => ({ db: { site: { findFirst: m.siteFindFirst }, user: { findUnique: vi.fn(async () => null) } } }));
vi.mock("@/lib/operations", () => ({
  createOrJoinActiveOperation: m.join,
  startOperation: m.start,
  succeedOperation: m.succeed,
  failOperation: m.fail
}));

import { POST } from "../app/api/sites/[siteId]/staging/route";
import { withStep } from "./progress";

const SITE = "44444444-4444-4444-8444-444444444444";
const params = { params: Promise.resolve({ siteId: SITE }) };
const req = (body: unknown) =>
  new Request("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  m.auth.mockResolvedValue({ user: { id: "admin", email: "a@example.com" } });
  m.workspace.mockResolvedValue({ id: "w" });
  m.permissions.mockResolvedValue({ canManageStagingEnvironment: true });
  m.siteFindFirst.mockResolvedValue({ id: SITE, organizationId: "org" });
});

describe("one staging change per app at a time", () => {
  it("answers 409 'already in progress' while another change runs, and starts nothing", async () => {
    m.join.mockResolvedValue({
      created: false,
      operation: { id: "op1", input: { enabled: true }, createdAt: new Date(), startedAt: new Date() }
    });
    const res = await POST(req({ enabled: true }), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ inProgress: true, toggleInProgress: { operationId: "op1", enabled: true } });
    expect(m.start).not.toHaveBeenCalled();
    expect(m.join).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "site.staging.toggle", resourceId: SITE, input: { enabled: true } }),
      { lockKey: `site.staging.toggle:${SITE}` }
    );
  });

  it("clears a change that died with its server and takes the lock again", async () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    m.join
      .mockResolvedValueOnce({ created: false, operation: { id: "dead", input: { enabled: true }, createdAt: old, startedAt: old } })
      .mockResolvedValueOnce({ created: false, operation: { id: "op2", input: { enabled: false }, createdAt: new Date(), startedAt: null } });
    const res = await POST(req({ enabled: true }), params);
    expect(m.fail).toHaveBeenCalledWith("dead", expect.any(String));
    expect(res.status).toBe(409);
  });

  it("refuses non-admins before taking any lock", async () => {
    m.permissions.mockResolvedValue({ canManageStagingEnvironment: false });
    const res = await POST(req({ enabled: true }), params);
    expect(res.status).toBe(403);
    expect(m.join).not.toHaveBeenCalled();
  });
});

describe("withStep", () => {
  it("returns the value and rethrows errors", async () => {
    await expect(withStep("a", "A", async () => 3)).resolves.toBe(3);
    await expect(withStep("a", "A", async () => { throw new Error("x"); })).rejects.toThrow("x");
  });
});
