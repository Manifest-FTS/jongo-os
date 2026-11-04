/**
 * Operations log: the durable record of a long-running task.
 *
 * An Operation is what a user or support sees ("Deploy started 14:02, failed at
 * 'build' with ..."). The pg-boss job that executes it is transient. Status
 * only moves forward:
 *
 *   queued ──> running ──> succeeded | failed
 *     └────────────────────> cancelled (only before it starts)
 *
 * Every transition is a conditional update, so two workers (or a retry racing
 * a late original) cannot both finish one operation, and a finished operation
 * is never reopened.
 */

export type OperationStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type StepStatus = "started" | "succeeded" | "failed" | "skipped";

export type OperationStep = { name: string; status: StepStatus; at: string; detail?: string };

export type OperationRecord = {
  id: string;
  organizationId: string | null;
  actorId: string | null;
  kind: string;
  resourceType: string | null;
  resourceId: string | null;
  status: OperationStatus;
  idempotencyKey: string | null;
  input: unknown;
  steps: OperationStep[] | null;
  result: unknown;
  error: string | null;
  attempts: number;
  jobId: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
};

export type CreateOperationInput = {
  kind: string;
  organizationId?: string | null;
  actorId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  input?: unknown;
  /** Same key → same operation. Scope it, e.g. `site.deploy:${siteId}:${requestId}`. */
  idempotencyKey?: string | null;
};

type Db = {
  operation: {
    create(args: unknown): Promise<OperationRecord>;
    findUnique(args: unknown): Promise<OperationRecord | null>;
    findFirst(args: unknown): Promise<OperationRecord | null>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  $transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
};

const MAX_ERROR_LENGTH = 4000;
const MAX_DETAIL_LENGTH = 1000;

async function loadDb(): Promise<Db> {
  const { db } = await import("@/lib/db");
  return db as Db;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Create an operation, or return the existing one for the same idempotency key.
 * `created` is false when the key was already used, so the caller must not
 * enqueue a second job.
 */
export async function createOperation(
  input: CreateOperationInput,
  options: { db?: Db } = {}
): Promise<{ operation: OperationRecord; created: boolean }> {
  const kind = input.kind.trim();
  if (!kind) throw new Error("Operation kind is required.");
  const idempotencyKey = input.idempotencyKey?.trim() || null;
  const db = options.db ?? (await loadDb());

  const data = {
    kind,
    organizationId: input.organizationId ?? null,
    actorId: input.actorId ?? null,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
    input: input.input === undefined ? undefined : (input.input as object),
    idempotencyKey
  };

  try {
    return { operation: await db.operation.create({ data }), created: true };
  } catch (error) {
    if (!idempotencyKey || !isUniqueViolation(error)) throw error;
    const existing = await db.operation.findUnique({ where: { idempotencyKey } });
    if (!existing) throw error;
    if (existing.kind !== kind) {
      throw new Error("Idempotency key was already used for a different kind of operation.");
    }
    return { operation: existing, created: false };
  }
}

/**
 * Join the operation already queued or running for the same resource, or
 * start a new one. Used where a second copy must never run at once (two
 * deploys of one app). A transaction-scoped Postgres lock on `lockKey`
 * serialises the check and the insert, so simultaneous requests — two tabs, a
 * double click — get one operation, not two.
 */
export async function createOrJoinActiveOperation(
  input: CreateOperationInput & { kind: string; resourceType: string; resourceId: string },
  match: { lockKey: string; inputEquals?: Record<string, string> },
  options: { db?: Db } = {}
): Promise<{ operation: OperationRecord; created: boolean }> {
  const db = options.db ?? (await loadDb());
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtextextended(${match.lockKey}, 0))`;
    const inputFilters = Object.entries(match.inputEquals ?? {}).map(([key, value]) => ({
      input: { path: [key], equals: value }
    }));
    const active = await tx.operation.findFirst({
      where: {
        kind: input.kind,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        status: { in: ["queued", "running"] },
        AND: inputFilters
      },
      orderBy: { createdAt: "desc" }
    });
    if (active) return { operation: active, created: false };
    return createOperation(input, { db: tx });
  });
}

export async function getOperation(id: string, options: { db?: Db } = {}): Promise<OperationRecord | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const db = options.db ?? (await loadDb());
  return db.operation.findUnique({ where: { id } });
}

/**
 * Merge fields into `result` while the operation runs, e.g. the hosting
 * deployment id once a deploy has been accepted, so a retry resumes instead of
 * starting the work again.
 */
export async function mergeOperationResult(
  id: string,
  fields: Record<string, unknown>,
  options: { db?: Db } = {}
): Promise<boolean> {
  const db = options.db ?? (await loadDb());
  const count = await db.$executeRaw`
    update "Operation"
    set "result" = coalesce("result", '{}'::jsonb) || ${JSON.stringify(fields)}::jsonb,
        "updatedAt" = now() at time zone 'utc'
    where "id" = ${id}::uuid and "status" = 'running'
  `;
  return count === 1;
}

/**
 * Mark an operation running and count the attempt. Also succeeds for an
 * operation already running, so a retry after a worker crash can pick it up.
 * Returns false when it is finished or cancelled; the job should then stop.
 */
export async function startOperation(id: string, jobId?: string | null, options: { db?: Db } = {}): Promise<boolean> {
  const db = options.db ?? (await loadDb());
  const now = new Date();
  const first = await db.operation.updateMany({
    where: { id, status: "queued" },
    data: { status: "running", attempts: { increment: 1 }, startedAt: now, jobId: jobId ?? undefined }
  });
  if (first.count === 1) return true;
  const retry = await db.operation.updateMany({
    where: { id, status: "running" },
    data: { attempts: { increment: 1 }, jobId: jobId ?? undefined }
  });
  return retry.count === 1;
}

/** Append a progress step. Steps are only added, never rewritten. */
export async function recordOperationStep(
  id: string,
  step: { name: string; status: StepStatus; detail?: string },
  options: { db?: Db; now?: Date } = {}
): Promise<void> {
  const db = options.db ?? (await loadDb());
  const entry: OperationStep = {
    name: step.name,
    status: step.status,
    at: (options.now ?? new Date()).toISOString(),
    ...(step.detail ? { detail: truncate(step.detail, MAX_DETAIL_LENGTH) } : {})
  };
  await db.$executeRaw`
    update "Operation"
    set "steps" = coalesce("steps", '[]'::jsonb) || jsonb_build_array(${JSON.stringify(entry)}::jsonb),
        "updatedAt" = now() at time zone 'utc'
    where "id" = ${id}::uuid and "status" = 'running'
  `;
}

/** Finish successfully. False if the operation was not running. */
export async function succeedOperation(id: string, result?: unknown, options: { db?: Db } = {}): Promise<boolean> {
  const db = options.db ?? (await loadDb());
  const done = await db.operation.updateMany({
    where: { id, status: "running" },
    data: { status: "succeeded", error: null, finishedAt: new Date() }
  });
  if (done.count === 1 && result !== undefined && result !== null && typeof result === "object") {
    // Merged into what the run already recorded (see mergeOperationResult).
    await db.$executeRaw`
      update "Operation" set "result" = coalesce("result", '{}'::jsonb) || ${JSON.stringify(result)}::jsonb
      where "id" = ${id}::uuid
    `;
  }
  return done.count === 1;
}

/**
 * Finish with an error. `message` is shown to the user, so pass a sentence
 * that says what failed, never a raw upstream response or credentials.
 */
export async function failOperation(id: string, message: string, options: { db?: Db } = {}): Promise<boolean> {
  const db = options.db ?? (await loadDb());
  const done = await db.operation.updateMany({
    where: { id, status: { in: ["queued", "running"] } },
    data: { status: "failed", error: truncate(message.trim() || "The operation failed.", MAX_ERROR_LENGTH), finishedAt: new Date() }
  });
  return done.count === 1;
}

/** Cancel before it starts. False once it is running or finished. */
export async function cancelOperation(id: string, options: { db?: Db } = {}): Promise<boolean> {
  const db = options.db ?? (await loadDb());
  const done = await db.operation.updateMany({
    where: { id, status: "queued" },
    data: { status: "cancelled", finishedAt: new Date() }
  });
  return done.count === 1;
}
