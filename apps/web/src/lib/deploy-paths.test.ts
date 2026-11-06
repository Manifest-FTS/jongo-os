import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  request: vi.fn(),
  enqueue: vi.fn(),
  getOperation: vi.fn(),
  siteFind: vi.fn(),
  siteUpdate: vi.fn(),
  auditCreate: vi.fn(),
  auditFindMany: vi.fn(),
  auth: vi.fn(),
  workspace: vi.fn(),
  deployments: vi.fn()
}));

vi.mock("@/lib/deploy-operation", () => ({ requestSiteDeploy: m.request }));
vi.mock("@/lib/job-queue", () => ({ enqueueOperationRun: m.enqueue }));
vi.mock("@/lib/operations", () => ({ getOperation: m.getOperation }));
vi.mock("@/lib/auth.config", () => ({ auth: m.auth }));
vi.mock("@/lib/repositories", () => ({ getSiteWorkspace: m.workspace, listSiteDeployments: m.deployments }));
vi.mock("@/lib/db", () => {
  const db = {
    site: { findUnique: m.siteFind, update: m.siteUpdate },
    auditLog: { create: m.auditCreate, findMany: m.auditFindMany }
  };
  return { getDb: async () => db, db };
});

import { deployNow } from "./github-deploys";
import { GET as promoteAttempt } from "../app/api/sites/[siteId]/staging/promote-attempt/route";

const SITE = { id: "site-1", organizationId: "org-1", coolifyServiceUuid: "app-uuid", stagingTargetUuid: null, githubInstallationId: null, gitStatus: "linked", pendingCommitSha: "abc1234" };

beforeEach(() => {
  vi.clearAllMocks();
  m.siteFind.mockResolvedValue(SITE);
  m.enqueue.mockResolvedValue(true);
  m.request.mockResolvedValue({ operation: { id: "op-1" }, created: true });
});

describe("GitHub 'Deploy' for a waiting commit", () => {
  it("queues a deploy operation and marks the commit as deployed", async () => {
    const out = await deployNow("site-1", "user-1");
    expect(out).toMatchObject({ ok: true, status: 200 });
    expect(m.request).toHaveBeenCalledWith({ siteId: "site-1", organizationId: "org-1", environment: "production", actorId: "user-1" });
    expect(m.enqueue).toHaveBeenCalledWith("op-1");
    expect(m.siteUpdate).toHaveBeenCalledWith({
      where: { id: "site-1" },
      data: expect.objectContaining({ pendingCommitSha: null, lastDeployedSha: "abc1234" })
    });
  });

  it("joins a running deploy without starting another, and keeps the commit waiting", async () => {
    m.request.mockResolvedValue({ operation: { id: "op-0" }, created: false });
    const out = await deployNow("site-1", "user-1");
    expect(out.ok).toBe(true);
    expect(out.message).toContain("already running");
    expect(m.enqueue).not.toHaveBeenCalled();
    expect(m.siteUpdate).not.toHaveBeenCalled();
  });

  it("says so when the deploy can't be queued", async () => {
    m.request.mockRejectedValue(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = await deployNow("site-1", "user-1");
    spy.mockRestore();
    expect(out).toMatchObject({ ok: false, status: 503 });
    expect(m.siteUpdate).not.toHaveBeenCalled();
  });
});

describe("promote status follows the final deploy", () => {
  const call = () =>
    promoteAttempt(new Request("http://localhost/x?attemptId=att-1"), { params: Promise.resolve({ siteId: "site-1" }) } as any);
  const event = (details: Record<string, unknown>) => [
    { id: "log-1", createdAt: new Date("2026-11-04T10:00:00Z"), details: { actionType: "staging_promote_triggered", promoteAttemptId: "att-1", message: "Promoted.", ...details } }
  ];

  beforeEach(() => {
    m.auth.mockResolvedValue({ user: { id: "user-1" } });
    m.workspace.mockResolvedValue({ id: "site-1", organizationId: "org-1" });
    m.deployments.mockResolvedValue([]);
  });

  it.each([
    ["running", "in_progress"],
    ["succeeded", "succeeded"],
    ["failed", "failed"]
  ])("operation %s → promote %s", async (opStatus, expected) => {
    m.auditFindMany.mockResolvedValue(event({ operationId: "op-1" }));
    m.getOperation.mockResolvedValue({
      id: "op-1", resourceId: "site-1", organizationId: "org-1", status: opStatus,
      error: opStatus === "failed" ? "The build failed." : null, createdAt: new Date(), finishedAt: opStatus === "running" ? null : new Date()
    });
    const body = await (await call()).json();
    expect(body.status).toBe(expected);
    if (opStatus === "failed") expect(body.message).toContain("The build failed.");
  });

  it("ignores an operation that belongs to another app", async () => {
    m.auditFindMany.mockResolvedValue(event({ operationId: "op-x" }));
    m.getOperation.mockResolvedValue({ id: "op-x", resourceId: "someone-else", organizationId: "org-2", status: "succeeded", createdAt: new Date(), finishedAt: new Date() });
    const body = await (await call()).json();
    expect(body.status).not.toBe("succeeded");
  });
});
