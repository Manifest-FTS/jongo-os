import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/leftovers/{deleted app id} — { action: "restore" | "destroy" }
 * for a hosting resource whose Jongo app was deleted (lib/leftovers.ts).
 * Client admins only; both actions are audited.
 */
export async function POST(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ ok: false, message: "Sign in first." }, { status: 401 });
  const { siteId } = await context.params;
  const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
  const { destroyLeftover, restoreLeftover } = await import("@/lib/leftovers");
  const result =
    body?.action === "restore"
      ? await restoreLeftover(siteId, userId)
      : body?.action === "destroy"
        ? await destroyLeftover(siteId, userId)
        : { ok: false as const, status: 400, message: "Choose restore or destroy." };
  return NextResponse.json(result.ok ? { ok: true, message: result.message } : { ok: false, message: result.message }, { status: result.ok ? 200 : result.status });
}
