import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { sendTransactionalEmail } from "@/lib/email";
import { canAccessRuntimeDiagnostics } from "@/lib/runtime-diagnostics";

function normalizeEmail(value?: string): string {
  return value?.trim().toLowerCase() ?? "";
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!canAccessRuntimeDiagnostics({ sessionEmail: session.user.email })) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { to?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const to = normalizeEmail(body.to) || normalizeEmail(session.user.email);
  if (!to) {
    return NextResponse.json({ error: "Recipient email is required" }, { status: 400 });
  }

  const result = await sendTransactionalEmail({
    to,
    subject: "Jongo SMTP test email",
    text: "This is a test transactional email from Jongo.",
    html: "<p>This is a test transactional email from <strong>Jongo</strong>.</p>"
  });

  if (!result.sent) {
    return NextResponse.json(
      {
        ok: false,
        provider: result.provider,
        error: result.error ?? "Email send failed"
      },
      { status: 503 }
    );
  }

  return NextResponse.json({
    ok: true,
    provider: result.provider,
    messageId: result.messageId ?? null
  });
}
