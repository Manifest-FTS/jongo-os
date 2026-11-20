import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { sendSecurityChangeEmail } from "@/lib/email";
import { signOutEverywhere } from "@/lib/two-factor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DELETE — sign this account out on every device, this one included. Every
 * existing session stops working on its next request; the browser then clears
 * its own cookie with next-auth's signOut().
 */
export async function DELETE() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, message: "Sign in first." }, { status: 401 });
  }
  const { getDb } = await import("@/lib/db");
  const db = await getDb();
  if (!db) {
    return NextResponse.json({ ok: false, message: "This isn't available right now. Please try again shortly." }, { status: 503 });
  }
  await signOutEverywhere(db, session.user.id);
  try {
    await sendSecurityChangeEmail({
      to: session.user.email,
      change: "signed_out_everywhere",
      settingsUrl: `${process.env.NEXTAUTH_URL?.replace(/\/$/, "") ?? ""}/settings?tab=security`
    });
  } catch (error) {
    console.error("[sessions] security email failed", error);
  }
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
