import { NextResponse } from "next/server";
import { hash } from "bcryptjs";

function isPrismaInitializationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.toLowerCase();

  return (
    normalized.includes("@prisma/client did not initialize yet") ||
    normalized.includes("prisma generate") ||
    normalized.includes("cannot find module '.prisma/client") ||
    normalized.includes("cannot find module '@prisma/client")
  );
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: "/api/setup/bootstrap",
    methods: ["POST"],
    message: "Create the first admin user by sending a POST JSON body.",
    requiredBody: {
      email: "string",
      password: "string (min 8 chars)",
      fullName: "string (optional)"
    },
    notes: [
      "Returns 409 when bootstrap already completed (at least one user exists).",
      "If SETUP_TOKEN is configured, pass Authorization: Bearer <SETUP_TOKEN>."
    ]
  });
}

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

    if (isPrismaInitializationError(err)) {
      return NextResponse.json(
        {
          error: "Prisma client is not initialized in this deployment.",
          guidance: [
            "Run prisma generate during install/build.",
            "Rebuild and redeploy the application.",
            "Ensure production start uses the Next standalone server output."
          ]
        },
        { status: 503 }
      );
    }

    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
