import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { isPlatformAdminEmail } from "@/lib/permissions";
import { sendBroadcast, type BroadcastDeliveryMode, type BroadcastScope } from "@/lib/notifications";

const SCOPES: BroadcastScope[] = ["all", "clients", "apps", "members"];
const MODES: BroadcastDeliveryMode[] = ["in_app", "email", "in_app_and_email"];

/**
 * POST /api/notifications/broadcast
 * { scope, clientIds?, siteIds?, userIds?, templateKey?, subject, message, deliveryMode, actionLink? }
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id || !(await isPlatformAdminEmail(session.user.email))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));

  const scope = SCOPES.includes(body?.scope) ? (body.scope as BroadcastScope) : null;
  const deliveryMode = MODES.includes(body?.deliveryMode) ? (body.deliveryMode as BroadcastDeliveryMode) : null;
  const subject = typeof body?.subject === "string" ? body.subject.trim() : "";
  const message = typeof body?.message === "string" ? body.message.trim() : "";

  if (!scope) {
    return NextResponse.json({ error: "scope must be one of all, clients, apps, members" }, { status: 400 });
  }
  if (!deliveryMode) {
    return NextResponse.json({ error: "deliveryMode must be one of in_app, email, in_app_and_email" }, { status: 400 });
  }
  if (!subject) {
    return NextResponse.json({ error: "subject is required" }, { status: 400 });
  }
  if (!message) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  const clientIds = Array.isArray(body?.clientIds) ? body.clientIds.filter((v: unknown) => typeof v === "string") : [];
  const siteIds = Array.isArray(body?.siteIds) ? body.siteIds.filter((v: unknown) => typeof v === "string") : [];
  const userIds = Array.isArray(body?.userIds) ? body.userIds.filter((v: unknown) => typeof v === "string") : [];

  if (scope === "clients" && clientIds.length === 0) {
    return NextResponse.json({ error: "Select at least one client" }, { status: 400 });
  }
  if (scope === "apps" && siteIds.length === 0) {
    return NextResponse.json({ error: "Select at least one app" }, { status: 400 });
  }
  if (scope === "members" && userIds.length === 0) {
    return NextResponse.json({ error: "Select at least one team member" }, { status: 400 });
  }

  try {
    const result = await sendBroadcast({
      createdBy: session.user.id,
      subject,
      message,
      templateKey: typeof body?.templateKey === "string" ? body.templateKey : null,
      deliveryMode,
      selection: { scope, clientIds, siteIds, userIds },
      actionLink: typeof body?.actionLink === "string" ? body.actionLink.trim() : undefined
    });

    if (result.recipientCount === 0) {
      return NextResponse.json(
        { ok: false, message: "No recipients matched that selection, so nothing was sent.", ...result },
        { status: 409 }
      );
    }

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("POST /api/notifications/broadcast error:", error);
    return NextResponse.json({ error: "Failed to send broadcast" }, { status: 500 });
  }
}
