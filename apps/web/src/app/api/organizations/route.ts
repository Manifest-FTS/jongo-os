import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";

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

    return NextResponse.json(
      organizations.map((org: any) => ({
        id: org.id,
        slug: org.slug,
        name: org.name,
        description: org.description,
        logoUrl: org.logoUrl,
        coolifyProjectId: org.coolifyProjectId,
        coolifyProjectName: org.coolifyProjectName,
        ownerId: org.ownerId,
        siteCount: org._count.sites,
        memberCount: org._count.collaborators,
        createdAt: org.createdAt
      }))
    );
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
            role: "owner"
          }
        }
      }
    });

    return NextResponse.json(
      {
        id: org.id,
        slug: org.slug,
        name: org.name,
        description: org.description,
        coolifyProjectId: org.coolifyProjectId,
        coolifyProjectName: org.coolifyProjectName,
        ownerId: org.ownerId,
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
