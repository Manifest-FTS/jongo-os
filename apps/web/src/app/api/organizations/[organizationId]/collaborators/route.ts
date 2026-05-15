import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";

type Params = { params: Promise<{ organizationId: string }> };

/**
 * GET /api/organizations/[organizationId]/collaborators
 * Returns all collaborators in an organization.
 */
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { organizationId } = await params;

  try {
    const { db } = await import("@/lib/db");

    // User must be a member to list collaborators
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

    const collaborators = await db.collaborator.findMany({
      where: { organizationId },
      include: { user: { select: { id: true, email: true, fullName: true, avatarUrl: true } } },
      orderBy: { createdAt: "asc" }
    });

    return NextResponse.json(
      collaborators.map((c: any) => ({
        id: c.id,
        userId: c.userId,
        role: c.role,
        email: c.user.email,
        fullName: c.user.fullName,
        avatarUrl: c.user.avatarUrl,
        createdAt: c.createdAt
      }))
    );
  } catch (err) {
    console.error("GET /api/organizations/[id]/collaborators error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * POST /api/organizations/[organizationId]/collaborators
 * Invite an existing user to an organization by email.
 * Requires owner or admin role.
 * Body: { email: string; role: "admin" | "operator" | "viewer" }
 */
export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { organizationId } = await params;

  let body: { email?: string; role?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  const role = body.role?.trim();

  if (!email) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }
  if (!role || !["admin", "operator", "viewer"].includes(role)) {
    return NextResponse.json({ error: "role must be admin, operator, or viewer" }, { status: 400 });
  }

  try {
    const { db } = await import("@/lib/db");

    // Only owner or admin may invite
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

    // Find the user to invite (must already exist)
    const targetUser = await db.user.findUnique({ where: { email } });
    if (!targetUser) {
      return NextResponse.json(
        { error: "No account found with that email address. The user must sign up first." },
        { status: 404 }
      );
    }

    // Prevent duplicate
    const existing = await db.collaborator.findFirst({
      where: { organizationId, userId: targetUser.id }
    });
    if (existing) {
      return NextResponse.json({ error: "That user is already a collaborator" }, { status: 409 });
    }

    const collaborator = await db.collaborator.create({
      data: {
        organizationId,
        userId: targetUser.id,
        role,
        grantedById: session.user.id
      },
      include: { user: { select: { id: true, email: true, fullName: true } } }
    });

    return NextResponse.json(
      {
        id: collaborator.id,
        userId: collaborator.userId,
        role: collaborator.role,
        email: collaborator.user.email,
        fullName: collaborator.user.fullName
      },
      { status: 201 }
    );
  } catch (err) {
    console.error("POST /api/organizations/[id]/collaborators error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
