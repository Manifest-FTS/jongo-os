import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getDb } from "@/lib/db";
import { listSiteDirectory } from "@/lib/repositories";

type FavoriteRow = { appId: string };

function isSchemaMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybe = error as { code?: string; message?: string };
  const message = (maybe.message ?? "").toLowerCase();
  return maybe.code === "P2022" || message.includes("userfavoriteapp");
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const prisma = await getDb();
  if (!prisma) {
    return NextResponse.json({ appIds: [] });
  }

  try {
    const [rows, visibleSites] = await Promise.all([
      prisma.$queryRaw<FavoriteRow[]>`
        SELECT "appId"
        FROM "UserFavoriteApp"
        WHERE "userId" = ${session.user.id}::uuid
      `,
      listSiteDirectory({ userId: session.user.id, email: session.user.email })
    ]);

    const visibleIds = new Set(visibleSites.map((site) => site.id));
    const appIds = rows
      .map((row: FavoriteRow) => row.appId)
      .filter((appId: string) => visibleIds.has(appId));

    return NextResponse.json({ appIds });
  } catch (error) {
    if (isSchemaMissing(error)) {
      return NextResponse.json({ appIds: [] });
    }
    return NextResponse.json({ error: "Could not load favorites" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const prisma = await getDb();
  if (!prisma) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const body = await request.json().catch(() => ({}));
  const appId = typeof body?.appId === "string" ? body.appId.trim() : "";
  const favorited = Boolean(body?.favorited);

  if (!appId || appId.length > 160) {
    return NextResponse.json({ error: "Invalid app id" }, { status: 400 });
  }

  const visibleSites = await listSiteDirectory({ userId: session.user.id, email: session.user.email });
  const canAccess = visibleSites.some((site) => site.id === appId);
  if (!canAccess) {
    return NextResponse.json({ error: "App not found" }, { status: 404 });
  }

  try {
    if (favorited) {
      await prisma.$executeRaw`
        INSERT INTO "UserFavoriteApp" ("userId", "appId")
        VALUES (${session.user.id}::uuid, ${appId})
        ON CONFLICT ("userId", "appId") DO NOTHING
      `;
    } else {
      await prisma.$executeRaw`
        DELETE FROM "UserFavoriteApp"
        WHERE "userId" = ${session.user.id}::uuid
          AND "appId" = ${appId}
      `;
    }

    return NextResponse.json({ ok: true, appId, favorited });
  } catch (error) {
    if (isSchemaMissing(error)) {
      return NextResponse.json({ error: "Favorites storage is not ready yet" }, { status: 503 });
    }
    return NextResponse.json({ error: "Could not update favorite" }, { status: 500 });
  }
}
