import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { isAdminRole, normalizeRole } from "@/lib/roles";

type Params = { params: Promise<{ siteId: string }> };

type CallerAccess = {
  siteId: string;
  orgId: string;
  orgOwnerId: string;
  callerRole: "admin" | "collaborator";
};

async function getCallerAccess(siteId: string, userId: string): Promise<CallerAccess | null> {
  const { db } = await import("@/lib/db");

  const site = await db.site.findFirst({
    where: {
      id: siteId,
      deletedAt: null,
      organization: {
        deletedAt: null,
        OR: [{ ownerId: userId }, { collaborators: { some: { userId } } }]
      }
    },
    include: {
      organization: {
        select: {
          id: true,
          ownerId: true,
          collaborators: {
            where: { userId },
            select: { role: true }
          }
        }
      },
      collaborators: {
        where: { userId },
        select: { role: true }
      }
    }
  });

  if (!site) {
    return null;
  }

  const orgAdmin = site.organization.ownerId === userId || isAdminRole(site.organization.collaborators[0]?.role);
  const siteAdmin = isAdminRole(site.collaborators[0]?.role);

  return {
    siteId: site.id,
    orgId: site.organization.id,
    orgOwnerId: site.organization.ownerId,
    callerRole: orgAdmin || siteAdmin ? "admin" : "collaborator"
  };
}

export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { siteId } = await params;

  try {
    const access = await getCallerAccess(siteId, session.user.id);
    if (!access) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const { db } = await import("@/lib/db");
    const rows = await db.siteCollaborator.findMany({
      where: { siteId },
      include: { user: { select: { id: true, email: true, fullName: true } } },
      orderBy: { createdAt: "asc" }
    });

    return NextResponse.json({
      collaborators: rows.map((row: any) => ({
        id: row.id,
        userId: row.userId,
        role: normalizeRole(row.role),
        email: row.user.email,
        fullName: row.user.fullName,
        createdAt: row.createdAt
      })),
      callerRole: access.callerRole
    });
  } catch (error) {
    console.error("GET /api/sites/[siteId]/collaborators error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { siteId } = await params;

  let body: { email?: string; role?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  const requestedRole = normalizeRole(body.role);

  if (!email) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }

  try {
    const access = await getCallerAccess(siteId, session.user.id);
    if (!access) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (access.callerRole !== "admin" && requestedRole === "admin") {
      return NextResponse.json({ error: "Only admins can invite admins" }, { status: 403 });
    }

    const { db } = await import("@/lib/db");
    const targetUser = await db.user.findUnique({ where: { email } });
    if (!targetUser) {
      return NextResponse.json({ error: "User account not found for that email" }, { status: 404 });
    }

    const existing = await db.siteCollaborator.findFirst({
      where: { siteId: access.siteId, userId: targetUser.id }
    });
    if (existing) {
      return NextResponse.json({ error: "That user is already on this app" }, { status: 409 });
    }

    const created = await db.siteCollaborator.create({
      data: {
        siteId: access.siteId,
        userId: targetUser.id,
        role: requestedRole
      },
      include: { user: { select: { id: true, email: true, fullName: true } } }
    });

    return NextResponse.json(
      {
        id: created.id,
        userId: created.userId,
        role: normalizeRole(created.role),
        email: created.user.email,
        fullName: created.user.fullName
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("POST /api/sites/[siteId]/collaborators error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
