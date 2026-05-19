import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { db } from "@/lib/db";
import { sendPasswordResetEmail } from "@/lib/email";

const TOKEN_TTL_MINUTES = 60;

export async function POST(req: NextRequest): Promise<NextResponse> {
  let email: string;
  try {
    const body = await req.json();
    email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Valid email is required" }, { status: 400 });
  }

  // Always return success to prevent user enumeration
  const successResponse = NextResponse.json(
    { ok: true, message: "If an account with that email exists, a reset link has been sent." },
    { status: 200 }
  );

  const user = await db.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash) {
    // No account or OAuth-only account — still return success
    return successResponse;
  }

  // Expire any existing unused tokens for this user
  await db.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
    data: { expiresAt: new Date() } // immediately expire
  });

  // Generate a secure random token
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60 * 1000);

  await db.passwordResetToken.create({
    data: { userId: user.id, tokenHash, expiresAt }
  });

  const baseUrl = process.env.NEXTAUTH_URL?.replace(/\/$/, "") ?? "";
  const resetUrl = `${baseUrl}/auth/reset-password/${rawToken}`;

  // Fire-and-forget — don't let email failure block the response
  sendPasswordResetEmail({ to: user.email, resetUrl, expiresAt }).catch(() => {
    // Silently swallow — user can retry
  });

  return successResponse;
}
