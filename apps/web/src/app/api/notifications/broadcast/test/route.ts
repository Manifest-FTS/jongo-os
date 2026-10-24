import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { isSuperAdminUser } from "@/lib/rbac";
import { normalizeBroadcastActionLink, sendBroadcastTest } from "@/lib/notifications";

/** Test sends are always delivered only to the authenticated super-admin. */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id || !(await isSuperAdminUser(session.user.id))) {
    return NextResponse.json({ error: "Super-admin access required" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const subject = typeof body?.subject === "string" ? body.subject.trim() : "";
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  const action = normalizeBroadcastActionLink({ label: body?.actionLinkLabel, url: body?.actionLinkUrl });
  if (!subject) return NextResponse.json({ error: "subject is required" }, { status: 400 });
  if (!message) return NextResponse.json({ error: "message is required" }, { status: 400 });
  if (action.error) return NextResponse.json({ error: action.error }, { status: 400 });

  try {
    const result = await sendBroadcastTest({
      createdBy: session.user.id,
      subject,
      message,
      actionLinkLabel: action.actionLink?.label,
      actionLinkUrl: action.actionLink?.url
    });
    return NextResponse.json({ ok: true, recipientCount: 1, ...result });
  } catch (error) {
    console.error("POST /api/notifications/broadcast/test error:", error);
    return NextResponse.json({ error: "Could not send the preview to your account" }, { status: 503 });
  }
}