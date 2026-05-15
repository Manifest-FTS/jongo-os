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

    const pendingInviteLogs = await db.auditLog.findMany({
      where: {
        organizationId,
        action: "collaborator_invited_pending"
      },
      orderBy: { createdAt: "desc" },
      take: 100
    });

    const existingEmails = new Set(
      collaborators.map((c: any) => c.user.email.toLowerCase())
    );

    const pendingInvites = pendingInviteLogs
      .map((log: any) => {
        const details = (log.details ?? {}) as {
          email?: string;
          role?: string;
          status?: string;
          delivery?: string;
          note?: string;
        };
        const email = details.email?.toLowerCase().trim();
        if (!email) return null;
        if (existingEmails.has(email)) return null;
        return {
          id: log.id,
          email,
          role: details.role ?? "viewer",
          status: details.status ?? "pending",
          delivery: details.delivery ?? "not_configured",
          note: details.note ?? "Email delivery not configured yet.",
          createdAt: log.createdAt
        };
      })
      .filter((item: any): item is NonNullable<typeof item> => Boolean(item));

    return NextResponse.json({
      collaborators: collaborators.map((c: any) => ({
        id: c.id,
        userId: c.userId,
        role: c.role,
        email: c.user.email,
        fullName: c.user.fullName,
        avatarUrl: c.user.avatarUrl,
        createdAt: c.createdAt
      })),
      pendingInvites,
      emailDeliveryConfigured: false
    });
  } catch (err) {
    console.error("GET /api/organizations/[id]/collaborators error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * POST /api/organizations/[organizationId]/collaborators
 * Invite a user to an organization by email.
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

    // If the user already exists, create collaborator membership immediately.
    const targetUser = await db.user.findUnique({ where: { email } });
    if (targetUser) {
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
          status: "active",
          id: collaborator.id,
          userId: collaborator.userId,
          role: collaborator.role,
          email: collaborator.user.email,
          fullName: collaborator.user.fullName
        },
        { status: 201 }
      );
    }

    // No account yet: create a pending invitation record.
    const recentPendingLogs = await db.auditLog.findMany({
      where: {
        organizationId,
        action: "collaborator_invited_pending"
      },
      orderBy: { createdAt: "desc" },
      take: 100
    });

    const existingPending = recentPendingLogs.find((log: any) => {
      const details = (log.details ?? {}) as { email?: string };
      return details.email?.toLowerCase().trim() === email;
    });

    if (!existingPending) {
      await db.auditLog.create({
        data: {
          organizationId,
          actorId: session.user.id,
          action: "collaborator_invited_pending",
          resourceType: "collaborator_invitation",
          resourceId: null,
          details: {
            email,
            role,
            status: "pending",
            delivery: "not_configured",
            note: "Email delivery not configured yet."
          }
        }
      });
    }

    return NextResponse.json(
      {
        status: "pending",
        email,
        role,
        delivery: "not_configured",
        message: "Invitation pending. Email delivery is not configured yet."
      },
      { status: 202 }
    );
  } catch (err) {
    console.error("POST /api/organizations/[id]/collaborators error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
