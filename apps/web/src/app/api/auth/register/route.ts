import { NextResponse } from "next/server";
import { hash } from "bcryptjs";

function isSelfRegistrationEnabled(): boolean {
  const raw = (process.env.ENABLE_SELF_REGISTRATION || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export async function POST(req: Request) {
  if (!isSelfRegistrationEnabled()) {
    return NextResponse.json(
      { error: "Self-registration is disabled." },
      { status: 403 }
    );
  }

  try {
    const { getDb } = await import("@/lib/db");
    const db = await getDb();

    if (!db) {
      return NextResponse.json({ error: "Database not available" }, { status: 503 });
    }

    const body = await req.json();
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const fullName = typeof body?.fullName === "string" ? body.fullName.trim() : "";

    if (!email || !password) {
      return NextResponse.json({ error: "email and password are required" }, { status: 400 });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "Invalid email format" }, { status: 400 });
    }

    if (password.length < 8) {
      return NextResponse.json({ error: "password must be at least 8 characters" }, { status: 400 });
    }

    const existingUser = await db.user.findUnique({ where: { email } });
    if (existingUser) {
      return NextResponse.json({ error: "An account with this email already exists." }, { status: 409 });
    }

    const passwordHash = await hash(password, 12);

    const user = await db.user.create({
      data: {
        email,
        fullName: fullName || email.split("@")[0],
        passwordHash,
        emailVerified: false,
        authProvider: "local"
      },
      select: { id: true, email: true, fullName: true }
    });

    return NextResponse.json({ ok: true, user }, { status: 201 });
  } catch (error) {
    console.error("[auth/register] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}