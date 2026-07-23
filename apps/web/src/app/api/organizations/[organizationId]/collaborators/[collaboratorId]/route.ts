import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { isAdminRole, normalizeRole } from "@/lib/roles";

type Params = { params: Promise<{ organizationId: string; collaboratorId: string }> };

/**
 * PUT /api/organizations/[organizationId]/collaborators/[collaboratorId]
 * Update a collaborator's role. Owner or admin only. Cannot change owner role.
 * Body: { role: "admin" | "collaborator" }
 */
export async function PUT(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { organizationId, collaboratorId } = await params;

  let body: { role?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const role = normalizeRole(body.role);
  if (!["admin", "collaborator"].includes(role)) {
    return NextResponse.json({ error: "role must be admin or collaborator" }, { status: 400 });
  }

  try {
    const { db } = await import("@/lib/db");

    // Caller must be owner or admin
    const org = await db.organization.findFirst({
      where: {
        id: organizationId,
        deletedAt: null,
        OR: [{ ownerId: session.user.id }, { collaborators: { some: { userId: session.user.id } } }]
      },
      include: {
        collaborators: {
          where: { userId: session.user.id },
          select: { role: true }
        }
      }
    });

    if (!org) {
      return NextResponse.json({ error: "Not found or insufficient permissions" }, { status: 404 });
    }

    const callerIsOwner = org.ownerId === session.user.id;
    const callerIsAdmin = callerIsOwner || isAdminRole(org.collaborators[0]?.role);
    if (!callerIsAdmin) {
      return NextResponse.json({ error: "Only admins can change roles" }, { status: 403 });
    }

    const collaborator = await db.collaborator.findFirst({
      where: { id: collaboratorId, organizationId }
    });

    if (!collaborator) {
      return NextResponse.json({ error: "Collaborator not found" }, { status: 404 });
    }

    const updated = await db.collaborator.update({
      where: { id: collaboratorId },
      data: { role }
    });

    return NextResponse.json({ id: updated.id, role: updated.role });
  } catch (err) {
    console.error("PUT /api/organizations/[id]/collaborators/[cid] error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * DELETE /api/organizations/[organizationId]/collaborators/[collaboratorId]
 * Remove a collaborator from the organization. Owner or admin only.
 * Cannot remove the owner.
 */
export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { organizationId, collaboratorId } = await params;

  try {
    const { db } = await import("@/lib/db");

    const org = await db.organization.findFirst({
      where: {
        id: organizationId,
        deletedAt: null,
        OR: [{ ownerId: session.user.id }, { collaborators: { some: { userId: session.user.id } } }]
      },
      include: {
        collaborators: {
          where: { userId: session.user.id },
          select: { role: true }
        }
      }
    });

    if (!org) {
      return NextResponse.json({ error: "Not found or insufficient permissions" }, { status: 404 });
    }

    const callerIsOwner = org.ownerId === session.user.id;
    const callerIsAdmin = callerIsOwner || isAdminRole(org.collaborators[0]?.role);
    if (!callerIsAdmin) {
      return NextResponse.json({ error: "Only admins can remove collaborators" }, { status: 403 });
    }

    const collaborator = await db.collaborator.findFirst({
      where: { id: collaboratorId, organizationId }
    });

    if (!collaborator) {
      return NextResponse.json({ error: "Collaborator not found" }, { status: 404 });
    }

    if (collaborator.userId === org.ownerId) {
      return NextResponse.json({ error: "Cannot remove the organization owner" }, { status: 403 });
    }

    const organizationSites = await db.site.findMany({
      where: { organizationId, deletedAt: null },
      select: { id: true }
    });
    const organizationSiteIds = organizationSites.map((site: { id: string }) => site.id);

    await db.$transaction([
      db.siteCollaborator.deleteMany({
        where: {
          userId: collaborator.userId,
          siteId: { in: organizationSiteIds }
        }
      }),
      db.userFavoriteApp.deleteMany({
        where: {
          userId: collaborator.userId,
          appId: { in: organizationSiteIds }
        }
      }),
      db.collaborator.delete({ where: { id: collaboratorId } })
    ]);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/organizations/[id]/collaborators/[cid] error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
