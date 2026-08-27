import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getDb } from "@/lib/db";

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH /api/notifications/[id]  { action: "read" | "dismiss" }
 *
 * Scoped to the caller's own userId in the WHERE clause rather than checked
 * separately — a notification belongs to exactly one recipient, so there is
 * no "read but not yours" case to distinguish, and this also makes the update
 * a no-op (not a 500) if someone guesses another user's notification id.
 */
export async function PATCH(request: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const action = body?.action === "dismiss" ? "dismiss" : body?.action === "read" ? "read" : null;
  if (!action) {
    return NextResponse.json({ error: "action must be 'read' or 'dismiss'" }, { status: 400 });
  }

  const db = await getDb();
  if (!db) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const now = new Date();
  const result = await db.notification.updateMany({
    where: { id, userId: session.user.id },
    data: action === "dismiss" ? { dismissedAt: now, readAt: now } : { readAt: now }
  });

  if (result.count === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
