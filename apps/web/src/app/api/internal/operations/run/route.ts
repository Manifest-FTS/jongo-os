import { NextResponse } from "next/server";
import { safeEqual } from "@/lib/safe-equal";

export const runtime = "nodejs";

/**
 * POST /api/internal/operations/run — machine token only.
 *
 * Called by scripts/worker.mjs for each job on the operation-run queue. Runs
 * one step of the operation in-process (where the typed hosting code lives),
 * then queues the next check if the operation is not finished yet.
 *
 * Answers:
 *  - 200 { done }                 step ran; nothing more to do, or next check queued
 *  - 503 { retry: true }          temporary problem; the worker retries this job
 *  - 500                          unexpected; on the final attempt the operation is failed
 */
function hasMachineToken(request: Request): boolean {
  const provided = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!provided) return false;
  return [process.env.BACKUP_RECONCILE_TOKEN, process.env.OWNERSHIP_SYNC_TOKEN].some(
    (token) => Boolean(token?.trim()) && safeEqual(provided, token!.trim())
  );
}

export async function POST(request: Request) {
  if (!hasMachineToken(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { operationId?: unknown; finalAttempt?: unknown } | null;
  const operationId = typeof body?.operationId === "string" ? body.operationId.trim() : "";
  if (!operationId) {
    return NextResponse.json({ error: "operationId is required" }, { status: 400 });
  }
  const finalAttempt = body?.finalAttempt === true;

  const { getOperation, failOperation } = await import("@/lib/operations");
  const operation = await getOperation(operationId);
  if (!operation) {
    return NextResponse.json({ done: true, reason: "not_found" });
  }

  try {
    const { SITE_DEPLOY_KIND, runSiteDeployStep } = await import("@/lib/deploy-operation");
    if (operation.kind !== SITE_DEPLOY_KIND) {
      await failOperation(operation.id, "This task type can't be run yet.");
      return NextResponse.json({ done: true, reason: "unknown_kind" });
    }

    const outcome = await runSiteDeployStep(operation.id);
    if (!outcome.done) {
      const { enqueueOperationRun } = await import("@/lib/job-queue");
      await enqueueOperationRun(operation.id, { startAfterSeconds: outcome.recheckAfterSeconds });
    }
    return NextResponse.json(outcome);
  } catch (error) {
    const retryable = error instanceof Error && error.name === "RetryLaterError";
    console.error("[operations] step failed", {
      operationId: operation.id,
      kind: operation.kind,
      retryable,
      finalAttempt,
      message: error instanceof Error ? error.message : String(error)
    });
    if (finalAttempt) {
      // No more retries are coming: never leave the operation "running" forever.
      await failOperation(operation.id, "Something went wrong while running this. Try again in a few minutes.").catch(
        () => undefined
      );
      return NextResponse.json({ done: true, reason: "gave_up" });
    }
    return NextResponse.json({ retry: true }, { status: retryable ? 503 : 500 });
  }
}
