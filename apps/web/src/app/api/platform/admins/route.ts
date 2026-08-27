import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getDb } from "@/lib/db";
import { checkIsPlatformAdmin, isPlatformAdminEmail } from "@/lib/permissions";

/**
 * GET /api/platform/admins
 *
 * Viewable by any platform admin (seed or granted) so a granted admin can see
 * who else has this access. Only the seed admin may add/remove (POST/DELETE
 * below) -- see PlatformAdmin in schema.prisma for why that isn't delegated.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id || !(await isPlatformAdminEmail(session.user.email))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const db = await getDb();
  if (!db) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const seedEmail = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim() ?? null;
  const grants = await db.platformAdmin.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      createdAt: true,
      user: { select: { id: true, email: true, fullName: true } },
      grantedByUser: { select: { email: true, fullName: true } }
    }
  });

  const admins = [
    ...(seedEmail
      ? [
          {
            id: "seed",
            email: seedEmail,
            fullName: null as string | null,
            isSeed: true,
            createdAt: null as string | null,
            grantedBy: null as string | null
          }
        ]
      : []),
    ...grants
      .filter((g: any) => g.user.email.toLowerCase() !== seedEmail?.toLowerCase())
      .map((g: any) => ({
        id: g.id,
        email: g.user.email,
        fullName: g.user.fullName,
        isSeed: false,
        createdAt: g.createdAt,
        grantedBy: g.grantedByUser?.fullName || g.grantedByUser?.email || null
      }))
  ];

  return NextResponse.json({
    admins,
    canManage: checkIsPlatformAdmin(session.user.email)
  });
}

/** POST /api/platform/admins  { email } — seed admin only. */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id || !checkIsPlatformAdmin(session.user.email)) {
    return NextResponse.json({ error: "Only the seed admin can grant platform admin access" }, { status: 403 });
  }

  const db = await getDb();
  if (!db) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const body = await request.json().catch(() => ({}));
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "A valid email address is required" }, { status: 400 });
  }

  const seedEmail = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  if (seedEmail && email.toLowerCase() === seedEmail) {
    return NextResponse.json({ error: "That email is already the seed admin" }, { status: 409 });
  }

  const user = await db.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" }, deletedAt: null },
    select: { id: true, email: true, fullName: true }
  });
  if (!user) {
    return NextResponse.json({ error: "No Jongo account exists for that email yet" }, { status: 404 });
  }

  const existing = await db.platformAdmin.findUnique({ where: { userId: user.id }, select: { id: true } });
  if (existing) {
    return NextResponse.json({ error: "That user is already a platform admin" }, { status: 409 });
  }

  const grant = await db.platformAdmin.create({
    data: { userId: user.id, grantedBy: session.user.id },
    select: { id: true, createdAt: true }
  });

  return NextResponse.json({
    ok: true,
    admin: { id: grant.id, email: user.email, fullName: user.fullName, isSeed: false, createdAt: grant.createdAt }
  });
}
