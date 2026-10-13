import { NextResponse } from "next/server";

export const runtime = "nodejs";

/** Callback for scripts/staging-db-copy.mjs: one staging database copy finished. */
export async function POST(request: Request) {
  const opsToken = process.env.BACKUP_RECONCILE_TOKEN?.trim() || process.env.OWNERSHIP_SYNC_TOKEN?.trim();
  const provided = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const alt = process.env.OWNERSHIP_SYNC_TOKEN?.trim();
  if (!provided || (provided !== opsToken && provided !== alt)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body: any = await request.json().catch(() => null);
  const id = typeof body?.stagingDatabaseId === "string" ? body.stagingDatabaseId.trim() : "";
  const result = typeof body?.result === "string" ? body.result : "";
  if (!/^[0-9a-f-]{36}$/i.test(id) || !["ok", "skipped", "fail"].includes(result)) {
    return NextResponse.json({ error: "stagingDatabaseId and result are required." }, { status: 400 });
  }
  const { recordStagingDbCopy } = await import("@/lib/staging-databases");
  const outcome = await recordStagingDbCopy({
    stagingDatabaseId: id,
    result,
    error: typeof body.error === "string" ? body.error.slice(0, 500) : null,
    tables: typeof body.tables === "number" ? body.tables : null
  });
  return NextResponse.json({ ok: outcome.ok }, { status: outcome.status });
}
