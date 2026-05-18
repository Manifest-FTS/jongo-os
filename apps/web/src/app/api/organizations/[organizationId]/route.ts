import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { isAdminRole } from "@/lib/roles";

type Params = { params: Promise<{ organizationId: string }> };

function normalize(value?: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

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
        collaborators: { where: { deletedAt: null }, include: { user: { select: { id: true, email: true, fullName: true } } } },
        _count: { select: { sites: true } }
      }
    });

    if (!org) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    let linkedCoolifyProjects: Array<{ coolifyProjectId: string; coolifyProjectName: string | null; isPrimary: boolean; driftState: "aligned" | "name_drift" | "unknown" }> = [];
    try {
      const links = await db.$queryRaw<Array<{ coolifyProjectId: string; coolifyProjectName: string | null; isPrimary: boolean }>>`
        select
          l."coolifyProjectId",
          l."coolifyProjectName",
          l."isPrimary"
        from "OrganizationCoolifyProjectLink" l
        where l."organizationId" = ${org.id}
          and l."deletedAt" is null
        order by l."isPrimary" desc, l."createdAt" asc
      `;

      linkedCoolifyProjects = links.map((link: { coolifyProjectId: string; coolifyProjectName: string | null; isPrimary: boolean }) => ({
        coolifyProjectId: link.coolifyProjectId,
        coolifyProjectName: link.coolifyProjectName,
        isPrimary: link.isPrimary,
        driftState:
          !link.coolifyProjectName
            ? "unknown"
            : normalize(link.coolifyProjectName) === normalize(org.name)
              ? "aligned"
              : "name_drift"
      }));
    } catch {
      linkedCoolifyProjects = [];
    }

    if (linkedCoolifyProjects.length === 0 && org.coolifyProjectId) {
      linkedCoolifyProjects.push({
        coolifyProjectId: org.coolifyProjectId,
        coolifyProjectName: org.coolifyProjectName,
        isPrimary: true,
        driftState:
          !org.coolifyProjectName
            ? "unknown"
            : normalize(org.coolifyProjectName) === normalize(org.name)
              ? "aligned"
              : "name_drift"
      });
    }

    return NextResponse.json({
      id: org.id,
      slug: org.slug,
      name: org.name,
      description: org.description,
      logoUrl: org.logoUrl,
      coolifyProjectId: org.coolifyProjectId,
      coolifyProjectName: org.coolifyProjectName,
      linkedCoolifyProjects,
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

    if (updates.coolifyProjectId) {
      const existingLink = await db.$queryRaw<Array<{ organizationName: string }>>`
        select o.name as "organizationName"
        from "OrganizationCoolifyProjectLink" l
        join "Organization" o on o.id = l."organizationId"
        where l."coolifyProjectId" = ${updates.coolifyProjectId}
          and l."organizationId" <> ${organizationId}
          and l."deletedAt" is null
          and o."deletedAt" is null
        limit 1
      `;

      if (existingLink.length > 0) {
        return NextResponse.json(
          { error: `That Coolify Project is already linked to ${existingLink[0].organizationName}.` },
          { status: 409 }
        );
      }
    }

    const updated = await db.organization.update({ where: { id: organizationId }, data: updates });

    if (updates.coolifyProjectId) {

      await db.$executeRaw`
        insert into "OrganizationCoolifyProjectLink" (
          id,
          "organizationId",
          "coolifyProjectId",
          "coolifyProjectName",
          "isPrimary",
          "deletedAt",
          "createdAt",
          "updatedAt"
        ) values (
          gen_random_uuid(),
          ${organizationId},
          ${updates.coolifyProjectId},
          ${updates.coolifyProjectName ?? null},
          true,
          null,
          now(),
          now()
        )
        on conflict ("organizationId", "coolifyProjectId")
        do update set
          "coolifyProjectName" = excluded."coolifyProjectName",
          "isPrimary" = true,
          "deletedAt" = null,
          "updatedAt" = now()
      `;

      await db.$executeRaw`
        update "OrganizationCoolifyProjectLink"
        set "isPrimary" = false, "updatedAt" = now()
        where "organizationId" = ${organizationId}
          and "coolifyProjectId" <> ${updates.coolifyProjectId}
          and "deletedAt" is null
      `;
    }

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
