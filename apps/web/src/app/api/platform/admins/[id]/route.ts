import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getDb } from "@/lib/db";
import { checkIsPlatformAdmin } from "@/lib/permissions";

type Params = { params: Promise<{ id: string }> };

/** DELETE /api/platform/admins/[id] — revoke a granted platform admin. Seed admin only; the seed itself has no row to delete. */
export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id || !checkIsPlatformAdmin(session.user.email)) {
    return NextResponse.json({ error: "Only the seed admin can revoke platform admin access" }, { status: 403 });
  }

  const { id } = await params;
  if (id === "seed") {
    return NextResponse.json({ error: "The seed admin is configured by environment variable and cannot be removed here" }, { status: 400 });
  }

  const db = await getDb();
  if (!db) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const result = await db.platformAdmin.deleteMany({ where: { id } });
  if (result.count === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
