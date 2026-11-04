import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  access: vi.fn(),
  deploy: vi.fn(),
  siteFindUnique: vi.fn(),
  envUpsert: vi.fn(),
  deploymentCreate: vi.fn(),
  auditCreate: vi.fn()
}));

vi.mock("@/lib/auth.config", () => ({ auth: m.auth }));
vi.mock("@/lib/tenant-route-access", () => ({ resolveSiteAccess: m.access }));
vi.mock("@/lib/coolify", () => ({ triggerCoolifyDeploy: m.deploy }));
vi.mock("@/lib/db", () => ({
  db: {
    site: { findUnique: m.siteFindUnique },
    environment: { upsert: m.envUpsert },
    deployment: { create: m.deploymentCreate },
    auditLog: { create: m.auditCreate }
  }
}));

import { POST } from "../app/api/coolify/deploy/route";

const SITE = "11111111-1111-4111-8111-111111111111";
const OWN_UUID = "own-coolify-uuid";
const STAGING_UUID = "own-staging-uuid";

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
    id: SITE, organizationId: "org-a", coolifyServiceUuid: OWN_UUID, stagingTargetUuid: STAGING_UUID
  });
  m.deploy.mockResolvedValue({ mode: "live", deploymentId: "dep-1", action: "deploy", message: "ok" });
  m.envUpsert.mockResolvedValue({ id: "env-1" });
});

describe("POST /api/coolify/deploy", () => {
  it("rejects anonymous callers", async () => {
    m.auth.mockResolvedValue(null);
    const res = await POST(request({ siteId: SITE }));
    expect(res.status).toBe(401);
    expect(m.deploy).not.toHaveBeenCalled();
  });

  it("refuses an app the caller has no access to, without revealing it exists", async () => {
    m.access.mockResolvedValue(null);
    const res = await POST(request({ siteId: SITE }));
    expect(res.status).toBe(404);
    expect(m.deploy).not.toHaveBeenCalled();
  });

  it("ignores a client-supplied hosting id and deploys the app's own resource", async () => {
    const res = await POST(request({ siteId: SITE, serviceUuid: "someone-elses-uuid" }));
    expect(res.status).toBe(200);
    expect(m.access).toHaveBeenCalledWith(SITE, "user-a");
    expect(m.deploy).toHaveBeenCalledWith(OWN_UUID, "production");
  });

  it("no longer accepts a bare hosting id", async () => {
    const res = await POST(request({ serviceUuid: "someone-elses-uuid" }));
    expect(res.status).toBe(400);
    expect(m.access).not.toHaveBeenCalled();
    expect(m.deploy).not.toHaveBeenCalled();
  });

  it("deploys staging to the staging copy, not production", async () => {
    await POST(request({ siteId: SITE, environment: "staging" }));
    expect(m.deploy).toHaveBeenCalledWith(STAGING_UUID, "staging");
  });

  it("refuses staging when there is no staging copy", async () => {
    m.siteFindUnique.mockResolvedValue({ id: SITE, organizationId: "org-a", coolifyServiceUuid: OWN_UUID, stagingTargetUuid: null });
    const res = await POST(request({ siteId: SITE, environment: "staging" }));
    expect(res.status).toBe(409);
    expect(m.deploy).not.toHaveBeenCalled();
  });

  it("reports failure instead of success when hosting rejects or is unconfigured", async () => {
    m.deploy.mockRejectedValue(new Error("Hosting is not configured"));
    const res = await POST(request({ siteId: SITE }));
    expect(res.status).toBe(502);
    expect(m.deploymentCreate).not.toHaveBeenCalled();
  });

  it("records the deploy against the caller's organization", async () => {
    await POST(request({ siteId: SITE }));
    expect(m.deploymentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ environmentId: "env-1", coolifyDeploymentId: "dep-1", triggeredById: "user-a" })
    });
    expect(m.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ organizationId: "org-a", actorId: "user-a", action: "deploy_triggered", resourceId: SITE })
    });
  });

  it("does not create a deployment row for a restart", async () => {
    m.deploy.mockResolvedValue({ mode: "live", deploymentId: "dep-placeholder", action: "restart", message: "ok" });
    await POST(request({ siteId: SITE }));
    expect(m.deploymentCreate).not.toHaveBeenCalled();
    expect(m.auditCreate).toHaveBeenCalled();
  });
});
