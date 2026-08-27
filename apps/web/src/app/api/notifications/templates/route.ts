import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getDb } from "@/lib/db";
import { isPlatformAdminEmail } from "@/lib/permissions";

/**
 * GET /api/notifications/templates
 *
 * Platform-admin only: broadcasts can target every client at once, so the
 * gate is the same bootstrap-admin check the other cross-client ops routes
 * use, not a per-client "admin" role (which only proves you administer one
 * client, not that you may message every client).
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id || !(await isPlatformAdminEmail(session.user.email))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = await getDb();
  if (!db) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const templates = await db.notificationTemplate.findMany({
    orderBy: { templateKey: "asc" },
    select: { id: true, templateKey: true, subject: true, bodyTemplate: true }
  });

  return NextResponse.json({ templates });
}
