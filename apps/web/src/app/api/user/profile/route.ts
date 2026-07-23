import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getDb } from "@/lib/db";
import { buildFullName, normalizeUsername, splitFullName } from "@/lib/profile";
import { getGravatarUrl } from "@/lib/gravatar";

type ProfileRow = {
  username: string | null;
  profileRole: string | null;
};

function normalizeEmail(value?: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

async function getProfileSettings(prisma: NonNullable<Awaited<ReturnType<typeof getDb>>>, userId: string): Promise<ProfileRow> {
  try {
    const rows = await prisma.$queryRaw<Array<ProfileRow>>`
      SELECT "username", "profileRole"
      FROM "UserProfileSettings"
      WHERE "userId" = ${userId}::uuid
        AND "deletedAt" IS NULL
      LIMIT 1
    `;

    return rows[0] ?? { username: null, profileRole: null };
  } catch {
    return { username: null, profileRole: null };
  }
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const prisma = await getDb();
  if (!prisma) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, email: true, fullName: true, avatarUrl: true }
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const profile = await getProfileSettings(prisma, session.user.id);
  const { firstName, lastName } = splitFullName(user.fullName);

  return NextResponse.json({
    id: user.id,
    email: user.email,
    firstName,
    lastName,
    username: profile.username ?? "",
    profileRole: profile.profileRole ?? "",
    imageUrl: user.avatarUrl ?? getGravatarUrl(user.email, 160)
  });
}

export async function PUT(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const prisma = await getDb();
  if (!prisma) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const body = await request.json().catch(() => ({}));
  const email = normalizeEmail(typeof body?.email === "string" ? body.email : session.user.email);
  const firstName = typeof body?.firstName === "string" ? body.firstName.trim() : "";
  const lastName = typeof body?.lastName === "string" ? body.lastName.trim() : "";
  const username = normalizeUsername(typeof body?.username === "string" ? body.username : "");
  const profileRole = typeof body?.profileRole === "string" ? body.profileRole.trim().slice(0, 80) : "";

  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "A valid email address is required" }, { status: 400 });
  }

  if (!firstName) {
    return NextResponse.json({ error: "First name is required" }, { status: 400 });
  }

  if (username && !/^[a-z0-9._-]{3,32}$/.test(username)) {
    return NextResponse.json({ error: "Username must be 3-32 characters using letters, numbers, dots, underscores, or dashes" }, { status: 400 });
  }

  const duplicateEmail = await prisma.user.findFirst({
    where: {
      email: { equals: email, mode: "insensitive" },
      id: { not: session.user.id },
      deletedAt: null
    },
    select: { id: true }
  });

  if (duplicateEmail) {
    return NextResponse.json({ error: "That email address is already in use" }, { status: 409 });
  }

  try {
    await prisma.user.update({
      where: { id: session.user.id },
      data: {
        email,
        fullName: buildFullName(firstName, lastName)
      },
      select: { id: true }
    });

    await prisma.$executeRaw`
      INSERT INTO "UserProfileSettings" ("userId", "username", "profileRole")
      VALUES (${session.user.id}::uuid, ${username || null}, ${profileRole || null})
      ON CONFLICT ("userId") DO UPDATE
      SET "username" = EXCLUDED."username",
          "profileRole" = EXCLUDED."profileRole",
          "deletedAt" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
    `;
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("userprofilesettings_username_key")) {
      return NextResponse.json({ error: "That username is already in use" }, { status: 409 });
    }

    return NextResponse.json({ error: "Failed to save profile settings" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}