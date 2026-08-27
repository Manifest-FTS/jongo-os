import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getDb } from "@/lib/db";
import { isPlatformAdminEmail } from "@/lib/permissions";

/** GET /api/notifications/broadcasts — Admin's "Activity History" tab. */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id || !(await isPlatformAdminEmail(session.user.email))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = await getDb();
  if (!db) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const broadcasts = await db.notificationBroadcast.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      templateKey: true,
      subject: true,
      deliveryMode: true,
      recipientScope: true,
      recipientCount: true,
      emailSentCount: true,
      emailFailedCount: true,
      createdAt: true,
      createdByUser: { select: { email: true, fullName: true } }
    }
  });

  return NextResponse.json({ broadcasts });
}
