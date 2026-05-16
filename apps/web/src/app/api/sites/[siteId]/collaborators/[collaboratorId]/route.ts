import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { isAdminRole, normalizeRole } from "@/lib/roles";

type Params = { params: Promise<{ siteId: string; collaboratorId: string }> };

type CallerAccess = {
  siteId: string;
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
    callerRole: orgAdmin || siteAdmin ? "admin" : "collaborator"
  };
}

export async function PUT(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { siteId, collaboratorId } = await params;

  let body: { role?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const requestedRole = normalizeRole(body.role);

  try {
    const access = await getCallerAccess(siteId, session.user.id);
    if (!access) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (access.callerRole !== "admin") {
      return NextResponse.json({ error: "Only admins can change app roles" }, { status: 403 });
    }

    const { db } = await import("@/lib/db");
    const collaborator = await db.siteCollaborator.findFirst({
      where: { id: collaboratorId, siteId: access.siteId }
    });

    if (!collaborator) {
      return NextResponse.json({ error: "Collaborator not found" }, { status: 404 });
    }

    const updated = await db.siteCollaborator.update({
      where: { id: collaboratorId },
      data: { role: requestedRole }
    });

    return NextResponse.json({ id: updated.id, role: normalizeRole(updated.role) });
  } catch (error) {
    console.error("PUT /api/sites/[siteId]/collaborators/[collaboratorId] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { siteId, collaboratorId } = await params;

  try {
    const access = await getCallerAccess(siteId, session.user.id);
    if (!access) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (access.callerRole !== "admin") {
      return NextResponse.json({ error: "Only admins can remove app collaborators" }, { status: 403 });
    }

    const { db } = await import("@/lib/db");
    await db.siteCollaborator.delete({ where: { id: collaboratorId } });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("DELETE /api/sites/[siteId]/collaborators/[collaboratorId] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
