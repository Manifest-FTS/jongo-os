import { NextResponse } from "next/server";
import { hash } from "bcryptjs";
import { randomBytes } from "node:crypto";

function workspaceSlug(base: string): string {
  const stem = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "workspace";
  return `${stem}-${randomBytes(3).toString("hex")}`;
}

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
    const firstName = typeof body?.firstName === "string" ? body.firstName.trim() : "";
    const lastName = typeof body?.lastName === "string" ? body.lastName.trim() : "";
    const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";

    if (!firstName || !lastName || !username || !email || !password) {
      return NextResponse.json({ error: "First name, last name, username, email address, and password are required." }, { status: 400 });
    }

    if (firstName.length > 80 || lastName.length > 80) {
      return NextResponse.json({ error: "Names must be 80 characters or fewer." }, { status: 400 });
    }

    if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
      return NextResponse.json({ error: "Username must be 3–32 characters and use only letters, numbers, dots, underscores, or dashes." }, { status: 400 });
    }

    if (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "Invalid email format" }, { status: 400 });
    }

    if (password.length < 8) {
      return NextResponse.json({ error: "password must be at least 8 characters" }, { status: 400 });
    }

    const existingUser = await db.user.findUnique({ where: { email } });
    if (existingUser) {
      return NextResponse.json({ error: "An account with this email already exists." }, { status: 409 });
    }

    const existingUsername = await db.userProfileSettings.findUnique({ where: { username }, select: { id: true } });
    if (existingUsername) {
      return NextResponse.json({ error: "That username is already taken." }, { status: 409 });
    }

    const passwordHash = await hash(password, 12);
    const displayName = `${firstName} ${lastName}`;

    // Without an organization a new account can't order domains, start transfers or add sites.
    const user = await db.$transaction(async (tx: any) => {
      const created = await tx.user.create({
        data: {
          email,
          fullName: displayName,
          passwordHash,
          emailVerified: false,
          authProvider: "local",
          profileSettings: { create: { username } }
        },
        select: { id: true, email: true, fullName: true }
      });
      await tx.organization.create({
        data: {
          slug: workspaceSlug(displayName),
          name: displayName,
          ownerId: created.id,
          collaborators: { create: { userId: created.id, role: "admin" } }
        }
      });
      return created;
    });

    return NextResponse.json({ ok: true, user }, { status: 201 });
  } catch (error) {
    const errorCode = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    if (errorCode === "P2002") {
      const target = JSON.stringify((error as { meta?: { target?: unknown } }).meta?.target ?? "").toLowerCase();
      return NextResponse.json(
        { error: target.includes("username") ? "That username is already taken." : "An account with this email already exists." },
        { status: 409 }
      );
    }
    console.error("[auth/register] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}