/**
 * Live progress for slow requests (creating an app takes up to a minute).
 *
 * Code anywhere below a request calls reportStep(); when the request asked for
 * progress (Accept: application/x-ndjson), each step is streamed to the browser
 * as one JSON line the moment it happens, followed by the normal response as
 * the last line. Without that header, reportStep() does nothing and the route
 * answers exactly as before.
 *
 * Steps are reported only when the work really starts or finishes, never on a
 * timer. If the browser leaves, the work carries on to the end; only the
 * stream stops.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type ProgressStatus = "active" | "done" | "skipped" | "failed";
export type ProgressStep = { id: string; label: string; status: ProgressStatus; detail?: string };

type Emit = (line: Record<string, unknown>) => void;
const current = new AsyncLocalStorage<Emit>();

export const PROGRESS_CONTENT_TYPE = "application/x-ndjson";

export function reportStep(id: string, label: string, status: ProgressStatus, detail?: string): void {
  current.getStore()?.({ type: "step", id, label, status, ...(detail ? { detail } : {}) });
}

export function wantsProgress(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes(PROGRESS_CONTENT_TYPE);
}

/** Run `handler` and stream its steps, then its response, as NDJSON. */
/**
 * A quiet step (a deploy can take minutes) must not look like a dead
 * connection to a proxy, which cuts idle responses (Cloudflare at ~100s).
 */
const KEEPALIVE_MS = 15_000;

export function progressResponse(handler: () => Promise<Response>): Response {
  const encoder = new TextEncoder();
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let push: Emit = () => {};
  let finish: () => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      push = (line) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        } catch {
          open = false; // the browser left; keep working regardless
        }
      };
      finish = () => {
        if (keepalive) clearInterval(keepalive);
        if (!open) return;
        open = false;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      push({ type: "started" });
      keepalive = setInterval(() => push({ type: "ping" }), KEEPALIVE_MS);
    },
    cancel() {
      if (keepalive) clearInterval(keepalive);
      push = () => {};
    }
  });

  void current.run(
    (line) => push(line),
    async () => {
      let response: Response;
      try {
        response = await handler();
      } catch (error) {
        console.error("[progress] request failed", error);
        response = Response.json({ ok: false, error: "Something went wrong. Nothing was created; try again." }, { status: 500 });
      }
      const body = await response.json().catch(() => ({}));
      push({ type: "result", status: response.status, body });
      finish();
    }
  );

  return new Response(stream, {
    headers: {
      "Content-Type": `${PROGRESS_CONTENT_TYPE}; charset=utf-8`,
      "Cache-Control": "no-cache, no-store, no-transform",
      "X-Accel-Buffering": "no"
    }
  });
}

/**
 * Run one step of a long request and report it: active, then done (or
 * failed if it throws, which is rethrown). Does nothing extra outside a
 * streamed request.
 */
export async function withStep<T>(id: string, label: string, run: () => Promise<T>, isOk?: (value: T) => boolean): Promise<T> {
  reportStep(id, label, "active");
  try {
    const value = await run();
    reportStep(id, label, isOk && !isOk(value) ? "failed" : "done");
    return value;
  } catch (error) {
    reportStep(id, label, "failed");
    throw error;
  }
}
