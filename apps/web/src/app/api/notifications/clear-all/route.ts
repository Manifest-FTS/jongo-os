import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getDb } from "@/lib/db";

/**
 * POST /api/notifications/clear-all
 *
 * The tray's "Clear All" — dismisses every one of the caller's notifications
 * that is still visible in the tray. Same dismiss semantics as the per-item
 * action, just applied in bulk; nothing is deleted, so /notifications?filter=all
 * still shows the full history.
 */
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await getDb();
  if (!db) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const now = new Date();
  const result = await db.notification.updateMany({
    where: { userId: session.user.id, dismissedAt: null },
    data: { dismissedAt: now, readAt: now }
  });

  return NextResponse.json({ ok: true, cleared: result.count });
}
