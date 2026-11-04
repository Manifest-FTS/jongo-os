import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  access: vi.fn(),
  request: vi.fn(),
  enqueue: vi.fn(),
  fail: vi.fn(),
  siteFindUnique: vi.fn(),
  auditCreate: vi.fn(),
  opFindFirst: vi.fn()
}));

vi.mock("@/lib/auth.config", () => ({ auth: m.auth }));
vi.mock("@/lib/tenant-route-access", () => ({ resolveSiteAccess: m.access }));
vi.mock("@/lib/job-queue", () => ({ enqueueOperationRun: m.enqueue }));
vi.mock("@/lib/operations", () => ({ failOperation: m.fail }));
vi.mock("@/lib/deploy-operation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./deploy-operation")>()),
  requestSiteDeploy: m.request
}));
vi.mock("@/lib/db", () => ({
  db: {
    site: { findUnique: m.siteFindUnique },
    auditLog: { create: m.auditCreate },
    operation: { findFirst: m.opFindFirst }
  }
}));

import { GET, POST } from "../app/api/coolify/deploy/route";

const SITE = "11111111-1111-4111-8111-111111111111";
const OP = {
  id: "22222222-2222-4222-8222-222222222222",
  kind: "site.deploy",
  status: "queued",
  input: { environment: "production" },
  steps: null,
  result: null,
  error: null,
  createdAt: new Date(),
  finishedAt: null
};

function request(body: unknown) {
  return new Request("http://localhost/api/coolify/deploy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }) as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.auth.mockResolvedValue({ user: { id: "user-a", email: "a@example.com" } });
  m.access.mockResolvedValue({ site: { id: SITE }, isAdmin: false, isPlatformAdmin: false });
  m.siteFindUnique.mockResolvedValue({
    id: SITE, organizationId: "org-a", coolifyServiceUuid: "own-uuid", stagingTargetUuid: "own-staging-uuid"
  });
  m.request.mockResolvedValue({ operation: OP, created: true });
  m.enqueue.mockResolvedValue(true);
  m.fail.mockResolvedValue(true);
});

describe("POST /api/coolify/deploy", () => {
  it("rejects anonymous callers", async () => {
    m.auth.mockResolvedValue(null);
    const res = await POST(request({ siteId: SITE }));
    expect(res.status).toBe(401);
    expect(m.request).not.toHaveBeenCalled();
  });

  it("refuses an app the caller has no access to, without revealing it exists", async () => {
    m.access.mockResolvedValue(null);
    const res = await POST(request({ siteId: SITE }));
    expect(res.status).toBe(404);
    expect(m.request).not.toHaveBeenCalled();
  });

  it("ignores a client-supplied hosting id and queues a deploy of the app itself", async () => {
    const res = await POST(request({ siteId: SITE, serviceUuid: "someone-elses-uuid" }));
    expect(res.status).toBe(202);
    expect(m.access).toHaveBeenCalledWith(SITE, "user-a");
    expect(m.request).toHaveBeenCalledWith({ siteId: SITE, organizationId: "org-a", environment: "production", actorId: "user-a" });
    expect(JSON.stringify(m.request.mock.calls)).not.toContain("someone-elses-uuid");
    expect(m.enqueue).toHaveBeenCalledWith(OP.id);
  });

  it("no longer accepts a bare hosting id", async () => {
    const res = await POST(request({ serviceUuid: "someone-elses-uuid" }));
    expect(res.status).toBe(400);
    expect(m.access).not.toHaveBeenCalled();
  });

  it("refuses staging when there is no staging copy", async () => {
    m.siteFindUnique.mockResolvedValue({ id: SITE, organizationId: "org-a", coolifyServiceUuid: "own-uuid", stagingTargetUuid: null });
    const res = await POST(request({ siteId: SITE, environment: "staging" }));
    expect(res.status).toBe(409);
    expect(m.request).not.toHaveBeenCalled();
  });

  it("returns the deploy already running instead of starting another", async () => {
    m.request.mockResolvedValue({ operation: { ...OP, status: "running" }, created: false });
    const res = await POST(request({ siteId: SITE }));
    const body = await res.json();
    expect(res.status).toBe(202);
    expect(body.alreadyRunning).toBe(true);
    expect(m.enqueue).not.toHaveBeenCalled();
    expect(m.auditCreate).not.toHaveBeenCalled();
  });

  it("fails the operation and says so when it can't be queued", async () => {
    m.enqueue.mockRejectedValue(new Error("db down"));
    const res = await POST(request({ siteId: SITE }));
    expect(res.status).toBe(503);
    expect(m.fail).toHaveBeenCalledWith(OP.id, expect.any(String));
  });

  it("audits the request against the caller's organization, and shows no hosting ids", async () => {
    const res = await POST(request({ siteId: SITE }));
    expect(m.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ organizationId: "org-a", actorId: "user-a", action: "deploy_triggered", resourceId: SITE })
    });
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("own-uuid");
  });
});

describe("GET /api/coolify/deploy", () => {
  it("only answers for an app the caller can access", async () => {
    m.access.mockResolvedValue(null);
    const res = await GET({ nextUrl: new URL(`http://localhost/api/coolify/deploy?siteId=${SITE}`) } as any);
    expect(res.status).toBe(404);
    expect(m.opFindFirst).not.toHaveBeenCalled();
  });

  it("looks up the latest deploy of that app only", async () => {
    m.opFindFirst.mockResolvedValue(OP);
    const res = await GET({ nextUrl: new URL(`http://localhost/api/coolify/deploy?siteId=${SITE}&environment=staging`) } as any);
    expect(res.status).toBe(200);
    expect(m.opFindFirst.mock.calls[0][0].where).toMatchObject({
      kind: "site.deploy",
      resourceType: "site",
      resourceId: SITE,
      input: { path: ["environment"], equals: "staging" }
    });
  });
});
