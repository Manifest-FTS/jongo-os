import { NextResponse } from "next/server";
import { collectUsage } from "@/lib/usage-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/ops/usage-collect
 *
 * Called every few minutes by scripts/usage-collector-scheduler.mjs. Takes one
 * reading of every container on the Docker host and folds it into the hourly
 * usage buckets. `?disk=1` forces a volume sizing pass (otherwise hourly).
 *
 * Same bearer token as the other ops routes: it can run SSH on the host, so it
 * must never be reachable with just a session cookie.
 */
export async function POST(request: Request) {
  const opsToken = process.env.BACKUP_RECONCILE_TOKEN?.trim() || process.env.OWNERSHIP_SYNC_TOKEN?.trim();
  const provided = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!opsToken || provided !== opsToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const forceDisk = new URL(request.url).searchParams.get("disk") === "1";
  try {
    const result = await collectUsage({ forceDisk });
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "usage collection failed" },
      { status: 500 }
    );
  }
}
