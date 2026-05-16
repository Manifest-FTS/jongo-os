import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { isAdminRole } from "@/lib/roles";

type Params = { params: Promise<{ organizationId: string }> };

async function getOrgForUser(organizationId: string, userId: string) {
  const { db } = await import("@/lib/db");

  return db.organization.findFirst({
    where: {
      id: organizationId,
      deletedAt: null,
      OR: [
        { ownerId: userId },
        { collaborators: { some: { userId } } }
      ]
    }
  });
}

/**
 * GET /api/organizations/[organizationId]
 * Returns a single organization the user has access to.
 */
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { organizationId } = await params;

  try {
    const { db } = await import("@/lib/db");

    const org = await db.organization.findFirst({
      where: {
        id: organizationId,
        deletedAt: null,
        OR: [
          { ownerId: session.user.id },
          { collaborators: { some: { userId: session.user.id } } }
        ]
      },
      include: {
        collaborators: { include: { user: { select: { id: true, email: true, fullName: true } } } },
        _count: { select: { sites: true } }
      }
    });

    if (!org) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({
      id: org.id,
      slug: org.slug,
      name: org.name,
      description: org.description,
      logoUrl: org.logoUrl,
      coolifyProjectId: org.coolifyProjectId,
      coolifyProjectName: org.coolifyProjectName,
      ownerId: org.ownerId,
      siteCount: org._count.sites,
      members: org.collaborators.map((c: any) => ({
        userId: c.userId,
        role: c.role,
        email: c.user.email,
        fullName: c.user.fullName
      })),
      createdAt: org.createdAt,
      updatedAt: org.updatedAt
    });
  } catch (err) {
    console.error("GET /api/organizations/[id] error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * PUT /api/organizations/[organizationId]
 * Updates name/description. Only the owner or an admin may do this.
 * Body: { name?: string; description?: string; coolifyProjectId?: string; coolifyProjectName?: string }
 */
export async function PUT(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { organizationId } = await params;

  let body: { name?: string; description?: string; coolifyProjectId?: string; coolifyProjectName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

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
      return NextResponse.json({ error: "Only admins can update client settings" }, { status: 403 });
    }

    const name = body.name?.trim();
    const updates: {
      name?: string;
      description?: string | null;
      slug?: string;
      coolifyProjectId?: string | null;
      coolifyProjectName?: string | null;
    } = {};
    if (name) {
      updates.name = name;
      updates.slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60);
    }
    if ("description" in body) {
      updates.description = body.description?.trim() || null;
    }
    if ("coolifyProjectId" in body) {
      updates.coolifyProjectId = body.coolifyProjectId?.trim() || null;
    }
    if ("coolifyProjectName" in body) {
      updates.coolifyProjectName = body.coolifyProjectName?.trim() || null;
    }

    const updated = await db.organization.update({ where: { id: organizationId }, data: updates });

    return NextResponse.json({ id: updated.id, slug: updated.slug, name: updated.name, description: updated.description });
  } catch (err) {
    console.error("PUT /api/organizations/[id] error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * DELETE /api/organizations/[organizationId]
 * Soft-deletes the organization. Only the owner may do this.
 */
export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { organizationId } = await params;

  try {
    const org = await getOrgForUser(organizationId, session.user.id);

    if (!org) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (org.ownerId !== session.user.id) {
      return NextResponse.json({ error: "Only the owner can delete an organization" }, { status: 403 });
    }

    const { db } = await import("@/lib/db");
    await db.organization.update({ where: { id: organizationId }, data: { deletedAt: new Date() } });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/organizations/[id] error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
