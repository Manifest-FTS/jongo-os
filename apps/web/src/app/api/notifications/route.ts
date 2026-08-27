import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getDb } from "@/lib/db";

/**
 * GET /api/notifications?filter=unread|all&limit=n
 *
 * Powers both the top-bar tray (limit=5, filter defaults to "all" so read
 * items stay visible until dismissed) and the /notifications page.
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await getDb();
  if (!db) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const url = new URL(request.url);
  const filter = url.searchParams.get("filter") === "unread" ? "unread" : "all";
  const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 50;

  const [notifications, unreadCount] = await Promise.all([
    db.notification.findMany({
      where: {
        userId: session.user.id,
        dismissedAt: null,
        ...(filter === "unread" ? { readAt: null } : {})
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        type: true,
        title: true,
        message: true,
        readAt: true,
        createdAt: true,
        clientId: true,
        appId: true
      }
    }),
    db.notification.count({
      where: { userId: session.user.id, dismissedAt: null, readAt: null }
    })
  ]);

  return NextResponse.json({ notifications, unreadCount });
}
