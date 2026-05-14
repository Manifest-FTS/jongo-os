import { NextResponse } from "next/server";
import { hash } from "bcryptjs";

/**
 * POST /api/setup/bootstrap
 *
 * Creates the first admin user. Fails with 409 if any user already exists.
 * Protected by SETUP_TOKEN env var when set — pass as Authorization: Bearer <token>.
 *
 * Body: { email: string; password: string; fullName?: string }
 */
export async function POST(req: Request) {
  try {
    const { getDb } = await import("@/lib/db");
    const db = await getDb();

    if (!db) {
      return NextResponse.json({ error: "Database not available" }, { status: 503 });
    }

    // If a setup token is configured, require it
    const setupToken = process.env.SETUP_TOKEN;
    if (setupToken) {
      const authHeader = req.headers.get("authorization") ?? "";
      const provided = authHeader.replace(/^Bearer\s+/i, "").trim();
      if (!provided || provided !== setupToken) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    const userCount = await db.user.count();
    if (userCount > 0) {
      return NextResponse.json(
        { error: "Bootstrap already complete. Use create-admin script to add more users." },
        { status: 409 }
      );
    }

    const body = await req.json();
    const { email, password, fullName } = body ?? {};

    if (!email || !password) {
      return NextResponse.json({ error: "email and password are required" }, { status: 400 });
    }

    if (typeof password !== "string" || password.length < 8) {
      return NextResponse.json({ error: "password must be at least 8 characters" }, { status: 400 });
    }

    // Basic email format check
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "Invalid email format" }, { status: 400 });
    }

    const passwordHash = await hash(password, 12);

    const user = await db.user.create({
      data: {
        email,
        fullName: fullName ?? (email as string).split("@")[0],
        passwordHash,
        emailVerified: true,
        authProvider: "local"
      },
      select: { id: true, email: true, fullName: true, createdAt: true }
    });

    return NextResponse.json({
      ok: true,
      message: "Admin user created. You can now log in.",
      user: { id: user.id, email: user.email, fullName: user.fullName }
    });
  } catch (err) {
    console.error("[setup/bootstrap] error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
