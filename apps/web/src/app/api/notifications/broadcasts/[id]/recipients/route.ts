import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getDb } from "@/lib/db";
import { isPlatformAdminEmail } from "@/lib/permissions";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/notifications/broadcasts/[id]/recipients
 *
 * Per-recipient read state for the Activity History expand view. This reuses
 * the readAt/dismissedAt already stamped on each recipient's own Notification
 * row -- "opened" means opened in Jongo's tray/notifications page, the same
 * signal the recipient's own UI already relies on. No new tracking pixel or
 * cookie: a broadcast sent as "Email Only" creates no Notification rows, so
 * it has nothing to show here (reported explicitly, not left blank).
 */
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id || !(await isPlatformAdminEmail(session.user.email))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const db = await getDb();
  if (!db) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const broadcast = await db.notificationBroadcast.findUnique({
    where: { id },
    select: { deliveryMode: true, recipientCount: true }
  });
  if (!broadcast) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const rows = await db.notification.findMany({
    where: { broadcastId: id },
    orderBy: [{ readAt: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      readAt: true,
      dismissedAt: true,
      createdAt: true,
      user: { select: { id: true, email: true, fullName: true } }
    }
  });

  return NextResponse.json({
    tracked: rows.length > 0 || broadcast.deliveryMode !== "email",
    recipients: rows.map((r: any) => ({
      userId: r.user.id,
      email: r.user.email,
      fullName: r.user.fullName,
      readAt: r.readAt,
      dismissedAt: r.dismissedAt
    }))
  });
}
