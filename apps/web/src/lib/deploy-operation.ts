/**
 * Deploys as Operations.
 *
 * The deploy button creates (or joins) an operation and returns at once. The
 * worker then calls runSiteDeployStep repeatedly:
 *
 *   1. start  — ask hosting to deploy the app's own resource (once, ever)
 *   2. build  — check the hosting deployment every 15s until it finishes
 *
 * Each call is short and resumable: what has happened is kept on the
 * operation, so a retry or a worker restart carries on rather than deploying a
 * second time.
 *
 * Messages stored here are shown to clients, so they say what happened in
 * plain words and never include hosting ids, URLs or raw upstream errors.
 */
import {
  failOperation,
  getOperation,
  mergeOperationResult,
  recordOperationStep,
  startOperation,
  succeedOperation,
  createOrJoinActiveOperation,
  type OperationRecord
} from "@/lib/operations";

export const SITE_DEPLOY_KIND = "site.deploy";
export type DeployEnvironment = "production" | "staging";

const RECHECK_SECONDS = 15;
const GIVE_UP_AFTER_MS = 60 * 60 * 1000;
const MAX_START_ATTEMPTS = 3;
/** Statuses where hosting turned the request away without starting anything. */
const RETRYABLE_STATUSES = new Set([0, 429, 500, 502, 503, 504]);

export type DeployStepOutcome = { done: true } | { done: false; recheckAfterSeconds: number };

/** Thrown to ask the worker to retry this step later (pg-boss retry with backoff). */
export class RetryLaterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryLaterError";
  }
}

type DeployResult = {
  startedAt?: string;
  action?: "deploy" | "restart";
  hostingDeploymentId?: string | null;
  deploymentRowId?: string | null;
  message?: string;
};

type Deps = {
  db: any;
  trigger: (uuid: string, environment: DeployEnvironment) => Promise<{
    deploymentId: string;
    action?: "deploy" | "restart";
    trackableDeploymentId?: string | null;
  }>;
  getState: (deploymentUuid: string) => Promise<string>;
  now: () => Date;
};

async function defaultDeps(): Promise<Deps> {
  const [{ db }, coolify] = await Promise.all([import("@/lib/db"), import("@/lib/coolify")]);
  return {
    db,
    trigger: coolify.triggerCoolifyDeploy,
    getState: coolify.getCoolifyDeploymentState,
    now: () => new Date()
  };
}

/** Create the deploy operation, or return the one already queued or running. */
export async function requestSiteDeploy(
  params: { siteId: string; organizationId: string; environment: DeployEnvironment; actorId: string | null },
  options: { db?: any } = {}
) {
  return createOrJoinActiveOperation(
    {
      kind: SITE_DEPLOY_KIND,
      organizationId: params.organizationId,
      actorId: params.actorId,
      resourceType: "site",
      resourceId: params.siteId,
      input: { environment: params.environment }
    },
    { lockKey: `${SITE_DEPLOY_KIND}:${params.siteId}:${params.environment}`, inputEquals: { environment: params.environment } },
    options.db ? { db: options.db } : {}
  );
}

function environmentOf(operation: OperationRecord): DeployEnvironment {
  const input = operation.input as { environment?: unknown } | null;
  return input?.environment === "staging" ? "staging" : "production";
}

async function setDeploymentRow(deps: Deps, rowId: string | null | undefined, status: "success" | "failed") {
  if (!rowId) return;
  try {
    await deps.db.deployment.updateMany({ where: { id: rowId }, data: { status, finishedAt: deps.now() } });
  } catch (error) {
    console.error("[deploy] could not update deployment row", { rowId, error });
  }
}

/** One step of a deploy. Safe to call again for the same operation. */
export async function runSiteDeployStep(operationId: string, injected?: Partial<Deps>): Promise<DeployStepOutcome> {
  const deps = { ...(await defaultDeps()), ...injected } as Deps;
  const operation = await getOperation(operationId, { db: deps.db });
  if (!operation || operation.kind !== SITE_DEPLOY_KIND) return { done: true };
  if (!(await startOperation(operation.id, null, { db: deps.db }))) return { done: true }; // finished or cancelled

  const result = (operation.result ?? {}) as DeployResult;
  const environment = environmentOf(operation);
  return result.startedAt
    ? followBuild(operation, result, deps)
    : startDeploy(operation, environment, deps);
}

async function startDeploy(operation: OperationRecord, environment: DeployEnvironment, deps: Deps): Promise<DeployStepOutcome> {
  const db = deps.db;
  const site = await db.site.findUnique({
    where: { id: operation.resourceId },
    select: { id: true, organizationId: true, coolifyServiceUuid: true, stagingTargetUuid: true, deletedAt: true }
  });
  const target = (environment === "staging" ? site?.stagingTargetUuid : site?.coolifyServiceUuid)?.trim() ?? "";
  if (!site || site.deletedAt || !target || site.organizationId !== operation.organizationId) {
    await failOperation(
      operation.id,
      environment === "staging"
        ? "This app no longer has a staging copy, so nothing was deployed."
        : "This app is no longer connected to hosting, so nothing was deployed.",
      { db }
    );
    return { done: true };
  }

  await recordOperationStep(operation.id, { name: "start", status: "started" }, { db });

  let triggered;
  try {
    triggered = await deps.trigger(target, environment);
  } catch (error) {
    const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : -1;
    const mayHaveStarted = (error as { mayHaveStarted?: unknown })?.mayHaveStarted === true;
    const attempt = operation.attempts + 1; // startOperation just counted this one
    console.error("[deploy] start failed", { operationId: operation.id, status, mayHaveStarted, attempt, message: (error as Error)?.message });

    if (!mayHaveStarted && RETRYABLE_STATUSES.has(status) && attempt < MAX_START_ATTEMPTS) {
      await recordOperationStep(operation.id, { name: "start", status: "failed", detail: "Hosting didn't respond. Trying again." }, { db });
      throw new RetryLaterError("hosting temporarily unavailable");
    }
    await recordOperationStep(operation.id, { name: "start", status: "failed" }, { db });
    await failOperation(
      operation.id,
      mayHaveStarted
        ? "Hosting didn't answer in time, so the deploy may still have started. Check the deployments page before trying again."
        : "Hosting couldn't start the deploy. Try again in a few minutes.",
      { db }
    );
    return { done: true };
  }

  const action = triggered.action ?? "deploy";
  const hostingDeploymentId = triggered.trackableDeploymentId ?? null;
  let deploymentRowId: string | null = null;

  // History row for a real deploy. A restart has no hosting deployment to track.
  if (action === "deploy") {
    try {
      const env = await db.environment.upsert({
        where: { siteId_name: { siteId: site.id, name: environment } },
        update: {},
        create: { siteId: site.id, name: environment, isProductionLike: environment === "production" },
        select: { id: true }
      });
      const row = await db.deployment.create({
        data: {
          environmentId: env.id,
          coolifyDeploymentId: triggered.deploymentId,
          status: "in_progress",
          triggeredAt: deps.now(),
          startedAt: deps.now(),
          triggeredById: operation.actorId
        },
        select: { id: true }
      });
      deploymentRowId = row.id;
    } catch (error) {
      console.error("[deploy] could not record deployment", { operationId: operation.id, error });
    }
  }

  // Recorded before anything else can fail, so a retry never deploys twice.
  await mergeOperationResult(
    operation.id,
    { startedAt: deps.now().toISOString(), action, hostingDeploymentId, deploymentRowId },
    { db }
  );
  await recordOperationStep(operation.id, { name: "start", status: "succeeded" }, { db });

  if (action === "restart" || !hostingDeploymentId) {
    await succeedOperation(
      operation.id,
      { message: action === "restart" ? "Restart started. The app is back in a minute or two." : "Deploy started." },
      { db }
    );
    return { done: true };
  }

  await recordOperationStep(operation.id, { name: "build", status: "started" }, { db });
  return { done: false, recheckAfterSeconds: RECHECK_SECONDS };
}

async function followBuild(operation: OperationRecord, result: DeployResult, deps: Deps): Promise<DeployStepOutcome> {
  const db = deps.db;
  if (!result.hostingDeploymentId) {
    await succeedOperation(operation.id, { message: "Deploy started." }, { db });
    return { done: true };
  }

  let state = "unknown";
  try {
    state = await deps.getState(result.hostingDeploymentId);
  } catch (error) {
    // A failed status check is not a failed deploy; look again next time.
    console.error("[deploy] status check failed", { operationId: operation.id, message: (error as Error)?.message });
  }

  if (state === "finished") {
    await setDeploymentRow(deps, result.deploymentRowId, "success");
    await recordOperationStep(operation.id, { name: "build", status: "succeeded" }, { db });
    await succeedOperation(operation.id, { message: "Deployed. Your changes are live." }, { db });
    return { done: true };
  }
  if (state === "failed" || state === "cancelled") {
    await setDeploymentRow(deps, result.deploymentRowId, "failed");
    await recordOperationStep(operation.id, { name: "build", status: "failed" }, { db });
    await failOperation(
      operation.id,
      state === "cancelled"
        ? "The deploy was cancelled before it finished. Your live app was not changed."
        : "The build failed, so your live app was not changed. The deployments page has the build log.",
      { db }
    );
    return { done: true };
  }

  const startedAt = result.startedAt ? new Date(result.startedAt).getTime() : deps.now().getTime();
  if (deps.now().getTime() - startedAt > GIVE_UP_AFTER_MS) {
    await recordOperationStep(operation.id, { name: "build", status: "failed", detail: "Still running after an hour." }, { db });
    await failOperation(
      operation.id,
      "The deploy was still running after an hour, so we stopped waiting for it. Check the deployments page for its result.",
      { db }
    );
    return { done: true };
  }
  return { done: false, recheckAfterSeconds: RECHECK_SECONDS };
}

/**
 * Deploy after a Git push. Normally a tracked operation, like Redeploy. If a
 * deploy is already running, a new operation would join it and this newer
 * commit would never deploy, so hosting is asked directly instead: it queues
 * deploys of the same app and builds this commit after the current one.
 */
export async function deployOnPush(params: {
  siteId: string;
  organizationId: string;
  environment: DeployEnvironment;
  targetUuid: string;
}): Promise<{ ok: boolean; via: "operation" | "hosting"; message: string }> {
  const { operation, created } = await requestSiteDeploy({
    siteId: params.siteId,
    organizationId: params.organizationId,
    environment: params.environment,
    actorId: null
  });
  if (created) {
    const { enqueueOperationRun } = await import("@/lib/job-queue");
    await enqueueOperationRun(operation.id);
    return { ok: true, via: "operation", message: "Deploy started." };
  }
  try {
    const { triggerCoolifyDeploy } = await import("@/lib/coolify");
    await triggerCoolifyDeploy(params.targetUuid, params.environment);
    return { ok: true, via: "hosting", message: "Queued after the deploy already running." };
  } catch (error) {
    return { ok: false, via: "hosting", message: error instanceof Error ? error.message : "The deploy didn't start." };
  }
}

/** What a client may see about a deploy operation. No hosting ids. */
export function publicDeployView(operation: OperationRecord) {
  const result = (operation.result ?? {}) as DeployResult;
  const steps = Array.isArray(operation.steps) ? operation.steps : [];
  const latest = new Map<string, string>();
  for (const step of steps) latest.set(step.name, step.status);
  return {
    id: operation.id,
    status: operation.status,
    environment: environmentOf(operation),
    stage:
      operation.status === "queued"
        ? "queued"
        : latest.has("build")
          ? "building"
          : latest.has("start")
            ? "starting"
            : operation.status === "running"
              ? "starting"
              : null,
    retrying: latest.get("start") === "failed" && operation.status === "running",
    message: operation.status === "failed" ? operation.error : result.message ?? null,
    createdAt: operation.createdAt,
    finishedAt: operation.finishedAt
  };
}
