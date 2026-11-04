/**
 * Sending side of the background queue (pg-boss in this app's Postgres).
 *
 * The web app only enqueues; scripts/worker.mjs runs the jobs. This client does
 * no scheduling or maintenance, so it adds one small connection pool and
 * nothing else.
 */
import type PgBossType from "pg-boss";

/** Runs one step of an Operation; see scripts/worker.mjs. */
export const OPERATION_RUN_QUEUE = "operation-run";

/** Kept identical to the worker's settings so whichever starts first creates it the same way. */
export const OPERATION_RUN_QUEUE_OPTIONS = {
  name: OPERATION_RUN_QUEUE,
  policy: "stately" as const, // per operation: at most one waiting and one running
  retryLimit: 3,
  retryDelay: 20,
  retryBackoff: true,
  expireInSeconds: 5 * 60
};

const globalForQueue = globalThis as unknown as { jongoBoss?: Promise<PgBossType> };

function connectionString(): string {
  const raw = (process.env.DATABASE_URL || "").trim();
  if (!raw) throw new Error("DATABASE_URL is required to queue background work.");
  const url = new URL(raw);
  for (const key of ["schema", "connection_limit", "pool_timeout", "pgbouncer", "statement_cache_size", "socket_timeout"]) {
    url.searchParams.delete(key);
  }
  return url.toString();
}

async function connect(): Promise<PgBossType> {
  const { default: PgBoss } = await import("pg-boss");
  const boss = new PgBoss({
    connectionString: connectionString(),
    schema: "pgboss",
    application_name: "jongo-web",
    max: 2,
    supervise: false,
    schedule: false
  });
  boss.on("error", (error: unknown) => console.error("[job-queue] pg-boss error", error));
  await boss.start();
  // Idempotent. Two processes creating it at once can deadlock in pg-boss, so retry.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await boss.createQueue(OPERATION_RUN_QUEUE, OPERATION_RUN_QUEUE_OPTIONS);
      break;
    } catch (error) {
      if (attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 1500));
    }
  }
  return boss;
}

async function getBoss(): Promise<PgBossType> {
  if (!globalForQueue.jongoBoss) {
    globalForQueue.jongoBoss = connect().catch((error) => {
      globalForQueue.jongoBoss = undefined; // try again on the next request
      throw error;
    });
  }
  return globalForQueue.jongoBoss;
}

/**
 * Queue a run of an operation. Returns false when a run is already waiting
 * for it (the queue keeps one per operation), which is not an error.
 */
export async function enqueueOperationRun(operationId: string, options: { startAfterSeconds?: number } = {}): Promise<boolean> {
  const boss = await getBoss();
  const id = await boss.send(
    OPERATION_RUN_QUEUE,
    { operationId },
    { singletonKey: operationId, ...(options.startAfterSeconds ? { startAfter: options.startAfterSeconds } : {}) }
  );
  return id !== null;
}
