import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getCoolifyOverview } from "@/lib/coolify";

type Params = { params: Promise<{ organizationId: string }> };

/**
 * GET /api/organizations/[organizationId]/sites
 * Returns all sites in an organization the user has access to.
 */
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { organizationId } = await params;

  try {
    const { db } = await import("@/lib/db");

    // Verify the user has access to this org
    const org = await db.organization.findFirst({
      where: {
        id: organizationId,
        deletedAt: null,
        OR: [
          { ownerId: session.user.id },
          { collaborators: { some: { userId: session.user.id } } }
        ]
      }
    });

    if (!org) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const sites = await db.site.findMany({
      where: { organizationId, deletedAt: null },
      include: {
        environments: { select: { id: true, name: true, isProductionLike: true } },
        _count: { select: { collaborators: true } }
      },
      orderBy: { name: "asc" }
    });

    return NextResponse.json(
      sites.map((site: any) => ({
        id: site.id,
        slug: site.slug,
        name: site.name,
        description: site.description,
        coolifyServiceId: site.coolifyServiceId,
        coolifyServiceUuid: site.coolifyServiceUuid,
        coolifyProjectId: site.coolifyProjectId,
        gitRepositoryUrl: site.gitRepositoryUrl,
        stagingEnabled: site.stagingEnabled,
        organizationId: site.organizationId,
        environments: site.environments,
        createdAt: site.createdAt
      }))
    );
  } catch (err) {
    console.error("GET /api/organizations/[id]/sites error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * POST /api/organizations/[organizationId]/sites
 * Creates a new site in the organization.
 * Body: { name: string; description?: string; coolifyServiceUuid?: string; gitRepositoryUrl?: string }
 */
export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { organizationId } = await params;

  let body: {
    name?: string;
    description?: string;
    coolifyServiceUuid?: string;
    gitRepositoryUrl?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

  try {
    const { db } = await import("@/lib/db");

    // Only owner or admin can create sites
    const org = await db.organization.findFirst({
      where: {
        id: organizationId,
        deletedAt: null,
        OR: [
          { ownerId: session.user.id },
          { collaborators: { some: { userId: session.user.id, role: { in: ["owner", "admin"] } } } }
        ]
      }
    });

    if (!org) {
      return NextResponse.json({ error: "Not found or insufficient permissions" }, { status: 404 });
    }

    const coolifyServiceUuid = body.coolifyServiceUuid?.trim() || null;
    let coolifyProjectId: string | null = null;
    let coolifyProjectName: string | null = null;

    if (coolifyServiceUuid) {
      const overview = await getCoolifyOverview();
      const matched = overview.sites.find(
        (site) => site.id === coolifyServiceUuid || site.deployTargetId === coolifyServiceUuid
      );
      coolifyProjectId = matched?.coolifyProjectId ?? null;
      coolifyProjectName = matched?.coolifyProjectName ?? null;

      if (coolifyProjectId && !org.coolifyProjectId) {
        await db.organization.update({
          where: { id: organizationId },
          data: {
            coolifyProjectId,
            coolifyProjectName: coolifyProjectName ?? undefined
          }
        });
      }
    }

    const site = await db.site.create({
      data: {
        organizationId,
        slug,
        name,
        description: body.description?.trim() || null,
        coolifyServiceUuid,
        coolifyProjectId,
        stagingEnabled: false,
        gitRepositoryUrl: body.gitRepositoryUrl?.trim() || null,
        environments: {
          create: [
            { name: "production", isProductionLike: true },
            { name: "staging", isProductionLike: false }
          ]
        }
      },
      include: { environments: { select: { id: true, name: true, isProductionLike: true } } }
    });

    return NextResponse.json(
      {
        id: site.id,
        slug: site.slug,
        name: site.name,
        description: site.description,
        coolifyServiceUuid: site.coolifyServiceUuid,
        coolifyProjectId: site.coolifyProjectId,
        stagingEnabled: site.stagingEnabled,
        gitRepositoryUrl: site.gitRepositoryUrl,
        organizationId: site.organizationId,
        environments: site.environments,
        createdAt: site.createdAt
      },
      { status: 201 }
    );
  } catch (err) {
    console.error("POST /api/organizations/[id]/sites error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
