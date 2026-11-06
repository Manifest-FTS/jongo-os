import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { resolveSiteAccess } from "@/lib/tenant-route-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEEPALIVE_MS = 25_000; // under Cloudflare's and Traefik's idle timeouts
const MAX_STREAM_MS = 30 * 60_000; // browsers reconnect on their own

/**
 * GET /api/sites/{siteId}/events — Server-Sent Events for one app.
 *
 * Sends `event: site` with { kind } whenever something about the app changes
 * (a deploy step, a backup or restore finishing, staging changes). The page
 * then re-reads what it shows through its normal routes. Access is checked
 * once, here, exactly as for any other app route.
 */
export async function GET(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const { siteId } = await context.params;
  const access = await resolveSiteAccess(siteId, userId);
  if (!access) return NextResponse.json({ error: "App not found." }, { status: 404 });
  const watchedId = access.site.id;

  const { subscribeToSite } = await import("@/lib/live-events-listener");
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          close();
        }
      };
      const unsubscribe = subscribeToSite(watchedId, (event) => {
        send(`event: site\ndata: ${JSON.stringify({ kind: event.kind, at: event.at })}\n\n`);
      });
      const keepalive = setInterval(() => send(": keepalive\n\n"), KEEPALIVE_MS);
      const limit = setTimeout(() => close(), MAX_STREAM_MS);
      function close() {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        clearTimeout(limit);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
      cleanup = close;
      request.signal.addEventListener("abort", close);
      // Retry hint for EventSource, and an immediate first byte so proxies open the stream.
      send("retry: 5000\n: connected\n\n");
    },
    cancel() {
      cleanup();
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // no-transform stops response compression from buffering the stream.
      "Cache-Control": "no-cache, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}
