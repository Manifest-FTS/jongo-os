import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { publicDeployView, requestSiteDeploy, runSiteDeployStep } from "./deploy-operation";
import { CoolifyDeployError } from "./coolify";

describe("publicDeployView", () => {
  it("shows stage and message but no hosting ids", () => {
    const view = publicDeployView({
      id: "op",
      status: "running",
      input: { environment: "staging" },
      steps: [
        { name: "start", status: "started", at: "" },
        { name: "start", status: "succeeded", at: "" },
        { name: "build", status: "started", at: "" }
      ],
      result: { hostingDeploymentId: "coolify-secret-uuid", deploymentRowId: "row" },
      error: null
    } as any);
    expect(view).toMatchObject({ status: "running", stage: "building", environment: "staging", retrying: false });
    expect(JSON.stringify(view)).not.toContain("coolify-secret-uuid");
  });
});

// Runs against a real Postgres when OPERATIONS_TEST_DATABASE_URL points at a
// disposable database with every migration applied. Sites, environments and
// deployment rows are faked; operations are real rows.
const url = process.env.OPERATIONS_TEST_DATABASE_URL;
describe.skipIf(!url)("deploy operations against Postgres", () => {
  let prisma: any;
  let db: any;
  const site = {
    id: "11111111-1111-4111-8111-111111111111",
    organizationId: null as string | null,
    coolifyServiceUuid: "own-uuid",
    stagingTargetUuid: "own-staging-uuid",
    deletedAt: null as Date | null
  };
  const fakes = {
    site: { findUnique: vi.fn(async () => site) },
    environment: { upsert: vi.fn(async () => ({ id: "env-1" })) },
    deployment: { create: vi.fn(async () => ({ id: "row-1" })), updateMany: vi.fn(async () => ({ count: 1 })) }
  };
  const clock = { now: new Date("2026-11-04T10:00:00Z") };
  const deps = (over: Record<string, unknown> = {}) => ({ db, now: () => clock.now, ...over }) as any;

  beforeAll(async () => {
    const { PrismaClient } = await import("@prisma/client");
    prisma = new PrismaClient({ datasources: { db: { url } } });
    db = new Proxy(prisma, { get: (target, key) => (key in fakes ? (fakes as any)[key] : target[key]) });
  });
  afterAll(async () => prisma?.$disconnect());
  beforeEach(async () => {
    await prisma.$executeRawUnsafe('delete from "Operation"');
    vi.clearAllMocks();
    site.deletedAt = null;
    clock.now = new Date("2026-11-04T10:00:00Z");
  });

  const newDeploy = async (environment: "production" | "staging" = "production") =>
    (await requestSiteDeploy({ siteId: site.id, organizationId: null as any, environment, actorId: null as any }, { db })).operation;

  it("gives simultaneous clicks one deploy, but keeps production and staging apart", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        requestSiteDeploy({ siteId: site.id, organizationId: null as any, environment: "production", actorId: null as any }, { db })
      )
    );
    expect(new Set(results.map((r) => r.operation.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);

    const staging = await newDeploy("staging");
    expect(staging.id).not.toBe(results[0].operation.id);
  });

  it("starts the app's own resource once, then follows the build to success", async () => {
    const op = await newDeploy();
    const trigger = vi.fn(async () => ({ deploymentId: "d1", action: "deploy" as const, trackableDeploymentId: "d1" }));
    const getState = vi.fn(async () => "in_progress");

    expect(await runSiteDeployStep(op.id, deps({ trigger, getState }))).toEqual({ done: false, recheckAfterSeconds: 15 });
    expect(trigger).toHaveBeenCalledWith("own-uuid", "production");

    // A later step (or a retry of this one) follows; it never deploys again.
    expect(await runSiteDeployStep(op.id, deps({ trigger, getState }))).toEqual({ done: false, recheckAfterSeconds: 15 });
    getState.mockResolvedValue("finished");
    expect(await runSiteDeployStep(op.id, deps({ trigger, getState }))).toEqual({ done: true });
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(getState).toHaveBeenCalledWith("d1");

    const row = await prisma.operation.findUnique({ where: { id: op.id } });
    expect(row.status).toBe("succeeded");
    expect(row.result).toMatchObject({ hostingDeploymentId: "d1", deploymentRowId: "row-1", message: expect.stringContaining("live") });
    expect(fakes.deployment.updateMany).toHaveBeenCalledWith({ where: { id: "row-1" }, data: expect.objectContaining({ status: "success" }) });
    expect(publicDeployView(row).status).toBe("succeeded");

    // A new click after it finished is a new deploy.
    expect((await newDeploy()).id).not.toBe(op.id);
  });

  it("reports a failed build without changing the live app", async () => {
    const op = await newDeploy();
    const trigger = vi.fn(async () => ({ deploymentId: "d1", action: "deploy" as const, trackableDeploymentId: "d1" }));
    await runSiteDeployStep(op.id, deps({ trigger, getState: async () => "queued" }));
    await runSiteDeployStep(op.id, deps({ trigger, getState: async () => "failed" }));
    const row = await prisma.operation.findUnique({ where: { id: op.id } });
    expect(row.status).toBe("failed");
    expect(row.error).toContain("build failed");
    expect(fakes.deployment.updateMany).toHaveBeenCalledWith({ where: { id: "row-1" }, data: expect.objectContaining({ status: "failed" }) });
  });

  it("retries when hosting turned the request away, then gives up after three tries", async () => {
    const op = await newDeploy();
    const trigger = vi.fn(async () => {
      throw new CoolifyDeployError("Coolify deploy failed (503)", 503, false);
    });
    await expect(runSiteDeployStep(op.id, deps({ trigger }))).rejects.toThrow("temporarily");
    await expect(runSiteDeployStep(op.id, deps({ trigger }))).rejects.toThrow("temporarily");
    expect(publicDeployView(await prisma.operation.findUnique({ where: { id: op.id } })).retrying).toBe(true);
    expect(await runSiteDeployStep(op.id, deps({ trigger }))).toEqual({ done: true });
    const row = await prisma.operation.findUnique({ where: { id: op.id } });
    expect(row.status).toBe("failed");
    expect(trigger).toHaveBeenCalledTimes(3);
  });

  it("never retries a timed-out start, which may have deployed", async () => {
    const op = await newDeploy();
    const trigger = vi.fn(async () => {
      throw new CoolifyDeployError("Coolify deploy failed (500): aborted", 0, true);
    });
    expect(await runSiteDeployStep(op.id, deps({ trigger }))).toEqual({ done: true });
    const row = await prisma.operation.findUnique({ where: { id: op.id } });
    expect(row.status).toBe("failed");
    expect(row.error).toContain("may still have started");
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("finishes a restart at once, with no deployment row to follow", async () => {
    const op = await newDeploy();
    const trigger = vi.fn(async () => ({ deploymentId: "dep-123", action: "restart" as const, trackableDeploymentId: null }));
    expect(await runSiteDeployStep(op.id, deps({ trigger }))).toEqual({ done: true });
    expect(fakes.deployment.create).not.toHaveBeenCalled();
    const row = await prisma.operation.findUnique({ where: { id: op.id } });
    expect(row.status).toBe("succeeded");
    expect(row.result.message).toContain("Restart");
  });

  it("refuses an app that was removed or moved after the click", async () => {
    const op = await newDeploy();
    site.deletedAt = new Date();
    const trigger = vi.fn();
    expect(await runSiteDeployStep(op.id, deps({ trigger }))).toEqual({ done: true });
    expect(trigger).not.toHaveBeenCalled();
    expect((await prisma.operation.findUnique({ where: { id: op.id } })).status).toBe("failed");
  });

  it("stops waiting after an hour and says so", async () => {
    const op = await newDeploy();
    const trigger = vi.fn(async () => ({ deploymentId: "d1", action: "deploy" as const, trackableDeploymentId: "d1" }));
    await runSiteDeployStep(op.id, deps({ trigger, getState: async () => "in_progress" }));
    clock.now = new Date("2026-11-04T11:01:00Z");
    expect(await runSiteDeployStep(op.id, deps({ trigger, getState: async () => "in_progress" }))).toEqual({ done: true });
    const row = await prisma.operation.findUnique({ where: { id: op.id } });
    expect(row.status).toBe("failed");
    expect(row.error).toContain("after an hour");
  });

  it("treats a failed status check as 'look again', not a failed deploy", async () => {
    const op = await newDeploy();
    const trigger = vi.fn(async () => ({ deploymentId: "d1", action: "deploy" as const, trackableDeploymentId: "d1" }));
    await runSiteDeployStep(op.id, deps({ trigger, getState: async () => "in_progress" }));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const outcome = await runSiteDeployStep(op.id, deps({ trigger, getState: async () => { throw new Error("timeout"); } }));
    spy.mockRestore();
    expect(outcome).toEqual({ done: false, recheckAfterSeconds: 15 });
    expect((await prisma.operation.findUnique({ where: { id: op.id } })).status).toBe("running");
  });
});
