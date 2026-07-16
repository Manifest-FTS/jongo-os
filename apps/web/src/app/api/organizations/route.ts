import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { importLinkedCoolifyProjectSites } from "@/lib/coolify-project-import";

function normalize(value?: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

/**
 * GET /api/organizations
 * Returns all organizations the current user belongs to (as owner or collaborator).
 */
export async function GET() {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { db } = await import("@/lib/db");

    const organizations = await db.organization.findMany({
      where: {
        deletedAt: null,
        OR: [
          { ownerId: session.user.id },
          { collaborators: { some: { userId: session.user.id } } }
        ]
      },
      include: {
        _count: { select: { sites: true, collaborators: true } }
      },
      orderBy: { name: "asc" }
    });

    const orgsWithMappings = await Promise.all(
      organizations.map(async (org: any) => {
        let linkedProjects: Array<{ coolifyProjectId: string; coolifyProjectName: string | null; isPrimary: boolean; driftState: "aligned" | "name_drift" | "unknown" }> = [];
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

          linkedProjects = links.map((link: { coolifyProjectId: string; coolifyProjectName: string | null; isPrimary: boolean }) => ({
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
          linkedProjects = [];
        }

        if (linkedProjects.length === 0 && org.coolifyProjectId) {
          linkedProjects.push({
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

        return {
          id: org.id,
          slug: org.slug,
          name: org.name,
          description: org.description,
          logoUrl: org.logoUrl,
          coolifyProjectId: org.coolifyProjectId,
          coolifyProjectName: org.coolifyProjectName,
          linkedCoolifyProjects: linkedProjects,
          ownerId: org.ownerId,
          siteCount: org._count.sites,
          memberCount: org._count.collaborators,
          createdAt: org.createdAt
        };
      })
    );

    return NextResponse.json(orgsWithMappings);
  } catch (err) {
    console.error("GET /api/organizations error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * POST /api/organizations
 * Creates a new organization owned by the current user.
 * Body: { name: string; description?: string }
 */
export async function POST(req: Request) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { name?: string; description?: string; coolifyProjectId?: string; coolifyProjectName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  // Derive a URL-safe slug from the name
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

  try {
    const { db } = await import("@/lib/db");

    const existing = await db.organization.findUnique({ where: { slug } });
    if (existing) {
      return NextResponse.json(
        { error: "An organization with that name already exists" },
        { status: 409 }
      );
    }

    if (body.coolifyProjectId?.trim()) {
      const existingLink = await db.$queryRaw<Array<{ organizationName: string }>>`
        select o.name as "organizationName"
        from "OrganizationCoolifyProjectLink" l
        join "Organization" o on o.id = l."organizationId"
        where l."coolifyProjectId" = ${body.coolifyProjectId.trim()}
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

    const org = await db.organization.create({
      data: {
        slug,
        name,
        description: body.description?.trim() || null,
        coolifyProjectId: body.coolifyProjectId?.trim() || null,
        coolifyProjectName: body.coolifyProjectName?.trim() || null,
        ownerId: session.user.id,
        collaborators: {
          create: {
            userId: session.user.id,
            role: "admin"
          }
        }
      }
    });

    if (org.coolifyProjectId) {
      try {
        await db.$executeRaw`
          insert into "OrganizationCoolifyProjectLink" (
            id,
            "organizationId",
            "coolifyProjectId",
            "coolifyProjectName",
            "isPrimary",
            "createdAt",
            "updatedAt"
          ) values (
            gen_random_uuid(),
            ${org.id},
            ${org.coolifyProjectId},
            ${org.coolifyProjectName},
            true,
            now(),
            now()
          )
        `;
      } catch {
        // Legacy compatibility: keep org-level fields even if link row cannot be created.
      }
    }

    if (org.coolifyProjectId) {
      try {
        await importLinkedCoolifyProjectSites(org.id);
      } catch (error) {
        console.error("[jongo] Failed to auto-import Coolify apps for new organization.", error);
      }
    }

    return NextResponse.json(
      {
        id: org.id,
        slug: org.slug,
        name: org.name,
        description: org.description,
        coolifyProjectId: org.coolifyProjectId,
        coolifyProjectName: org.coolifyProjectName,
        linkedCoolifyProjects: org.coolifyProjectId
          ? [
              {
                coolifyProjectId: org.coolifyProjectId,
                coolifyProjectName: org.coolifyProjectName,
                isPrimary: true,
                driftState:
                  !org.coolifyProjectName
                    ? "unknown"
                    : normalize(org.coolifyProjectName) === normalize(org.name)
                      ? "aligned"
                      : "name_drift"
              }
            ]
          : [],
        siteCount: 0,
        memberCount: 1,
        createdAt: org.createdAt
      },
      { status: 201 }
    );
  } catch (err) {
    console.error("POST /api/organizations error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
