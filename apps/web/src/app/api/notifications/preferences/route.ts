import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getDb } from "@/lib/db";

/** GET /api/notifications/preferences */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await getDb();
  if (!db) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const settings = await db.userProfileSettings.findUnique({
    where: { userId: session.user.id },
    select: { emailNotificationsEnabled: true, backupAlertsEnabled: true }
  });

  return NextResponse.json({
    emailNotificationsEnabled: settings?.emailNotificationsEnabled ?? true,
    backupAlertsEnabled: settings?.backupAlertsEnabled ?? true
  });
}

/** PATCH /api/notifications/preferences  { emailNotificationsEnabled?, backupAlertsEnabled? } */
export async function PATCH(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await getDb();
  if (!db) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const body = await request.json().catch(() => ({}));
  const emailNotificationsEnabled =
    typeof body?.emailNotificationsEnabled === "boolean" ? body.emailNotificationsEnabled : undefined;
  const backupAlertsEnabled = typeof body?.backupAlertsEnabled === "boolean" ? body.backupAlertsEnabled : undefined;

  if (emailNotificationsEnabled === undefined && backupAlertsEnabled === undefined) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const settings = await db.userProfileSettings.upsert({
    where: { userId: session.user.id },
    create: {
      userId: session.user.id,
      emailNotificationsEnabled: emailNotificationsEnabled ?? true,
      backupAlertsEnabled: backupAlertsEnabled ?? true
    },
    update: {
      ...(emailNotificationsEnabled !== undefined ? { emailNotificationsEnabled } : {}),
      ...(backupAlertsEnabled !== undefined ? { backupAlertsEnabled } : {})
    },
    select: { emailNotificationsEnabled: true, backupAlertsEnabled: true }
  });

  return NextResponse.json(settings);
}
