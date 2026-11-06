import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cancelOperation,
  createOperation,
  failOperation,
  recordOperationStep,
  startOperation,
  succeedOperation
} from "./operations";

describe("operations without a database", () => {
  it("requires a kind", async () => {
    const db = { operation: { create: vi.fn() } } as any;
    await expect(createOperation({ kind: "  " }, { db })).rejects.toThrow("kind is required");
    expect(db.operation.create).not.toHaveBeenCalled();
  });

  it("rethrows a unique violation when no idempotency key was given", async () => {
    const db = { operation: { create: vi.fn().mockRejectedValue({ code: "P2002" }), findUnique: vi.fn() } } as any;
    await expect(createOperation({ kind: "site.deploy" }, { db })).rejects.toEqual({ code: "P2002" });
    expect(db.operation.findUnique).not.toHaveBeenCalled();
  });
});

// Runs against a real Postgres when OPERATIONS_TEST_DATABASE_URL points at a
// disposable database with every migration applied.
const url = process.env.OPERATIONS_TEST_DATABASE_URL;
describe.skipIf(!url)("operations against Postgres", () => {
  let db: any;
  beforeAll(async () => {
    const { PrismaClient } = await import("@prisma/client");
    db = new PrismaClient({ datasources: { db: { url } } });
    await db.$executeRawUnsafe('delete from "Operation"');
  });
  afterAll(async () => db?.$disconnect());

  it("returns the same operation for concurrent requests with one key", async () => {
    const key = `deploy:site-1:${Date.now()}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, () => createOperation({ kind: "site.deploy", idempotencyKey: key }, { db }))
    );
    expect(new Set(results.map((r) => r.operation.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });

  it("refuses to reuse a key for a different kind", async () => {
    const key = `k:${Date.now()}`;
    await createOperation({ kind: "site.deploy", idempotencyKey: key }, { db });
    await expect(createOperation({ kind: "site.restore", idempotencyKey: key }, { db })).rejects.toThrow("different kind");
  });

  it("moves forward only, and records steps while running", async () => {
    const { operation } = await createOperation({ kind: "site.deploy", input: { siteId: "s" } }, { db });
    expect(operation.status).toBe("queued");

    // Steps are ignored until it runs.
    await recordOperationStep(operation.id, { name: "early", status: "started" }, { db });

    expect(await startOperation(operation.id, "job-1", { db })).toBe(true);
    expect(await startOperation(operation.id, "job-2", { db })).toBe(true); // retry after a crash
    await recordOperationStep(operation.id, { name: "build", status: "started" }, { db });
    await recordOperationStep(operation.id, { name: "build", status: "succeeded", detail: "x".repeat(5000) }, { db });
    expect(await succeedOperation(operation.id, { url: "https://example.test" }, { db })).toBe(true);

    expect(await succeedOperation(operation.id, undefined, { db })).toBe(false);
    expect(await failOperation(operation.id, "late failure", { db })).toBe(false);
    expect(await startOperation(operation.id, "job-3", { db })).toBe(false);
    expect(await cancelOperation(operation.id, { db })).toBe(false);

    const row = await db.operation.findUnique({ where: { id: operation.id } });
    expect(row.status).toBe("succeeded");
    expect(row.attempts).toBe(2);
    expect(row.jobId).toBe("job-2");
    expect(row.error).toBeNull();
    expect(row.startedAt).toBeInstanceOf(Date);
    expect(row.finishedAt).toBeInstanceOf(Date);
    expect(row.steps.map((s: any) => `${s.name}:${s.status}`)).toEqual(["build:started", "build:succeeded"]);
    expect(row.steps[1].detail.length).toBe(1000);
    expect(row.result).toEqual({ url: "https://example.test" });
  });

  it("cancels only before it starts", async () => {
    const queued = (await createOperation({ kind: "site.deploy" }, { db })).operation;
    expect(await cancelOperation(queued.id, { db })).toBe(true);
    expect(await startOperation(queued.id, null, { db })).toBe(false);

    const running = (await createOperation({ kind: "site.deploy" }, { db })).operation;
    await startOperation(running.id, null, { db });
    expect(await cancelOperation(running.id, { db })).toBe(false);
    expect(await failOperation(running.id, "  ", { db })).toBe(true);
    const row = await db.operation.findUnique({ where: { id: running.id } });
    expect(row.error).toBe("The operation failed.");
  });
});
