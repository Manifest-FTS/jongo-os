import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { isSmtpConfigured, sendInviteEmail } from "@/lib/email";
import { getGravatarUrl } from "@/lib/gravatar";
import {
  buildInviteUrlForInvitation,
  createInviteToken,
  createInviteTokenForInvitation,
  getInviteExpiryDate,
  hashInviteToken,
  isInviteExpired
} from "@/lib/invitations";
import { isAdminRole, normalizeRole } from "@/lib/roles";
import { getPlatformAdminContacts } from "@/lib/permissions";

type Params = { params: Promise<{ organizationId: string }> };

function getInvitationStatus(invite: {
  acceptedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
}): "pending" | "accepted" | "expired" | "revoked" {
  if (invite.revokedAt) return "revoked";
  if (invite.acceptedAt) return "accepted";
  if (isInviteExpired(invite.expiresAt)) return "expired";
  return "pending";
}

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

    const pendingInvites = await db.invitation.findMany({
      where: {
        organizationId,
        inviteType: "organization"
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        email: true,
        role: true,
        expiresAt: true,
        createdAt: true,
        acceptedAt: true,
        revokedAt: true,
        deliveryStatus: true,
        deliveryError: true
      }
    });

    return NextResponse.json({
      collaborators: collaborators.map((c: any) => ({
        id: c.id,
        userId: c.userId,
        role: c.role,
        email: c.user.email,
        fullName: c.user.fullName,
        avatarUrl: c.user.avatarUrl ?? getGravatarUrl(c.user.email, 96),
        createdAt: c.createdAt
      })),
      pendingInvites: pendingInvites.map((invite: any) => ({
        id: invite.id,
        email: invite.email,
        role: normalizeRole(invite.role),
        status: getInvitationStatus(invite),
        inviteUrl: getInvitationStatus(invite) === "pending" ? buildInviteUrlForInvitation(invite.id) : null,
        delivery: invite.deliveryStatus,
        note: invite.deliveryError ?? null,
        acceptedAt: invite.acceptedAt,
        revokedAt: invite.revokedAt,
        expiresAt: invite.expiresAt,
        createdAt: invite.createdAt
      })),
      platformAdmins: await getPlatformAdminContacts(),
      emailDeliveryConfigured: isSmtpConfigured()
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
 * Body: { email: string; role: "admin" | "collaborator" }
 */
export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { organizationId } = await params;

  let body: { email?: string; role?: string; forceInvite?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  const role = normalizeRole(body.role);
  const forceInvite = body.forceInvite === true;

  if (!email) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }
  if (!["admin", "collaborator"].includes(role)) {
    return NextResponse.json({ error: "role must be admin or collaborator" }, { status: 400 });
  }

  try {
    const { db } = await import("@/lib/db");

    // Only owner or admin may invite
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
      return NextResponse.json({ error: "Only admins can invite collaborators" }, { status: 403 });
    }

    const targetUser = await db.user.findUnique({ where: { email } });
    if (targetUser && !forceInvite) {
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

    const existingPending = await db.invitation.findFirst({
      where: {
        organizationId,
        inviteType: "organization",
        email,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() }
      },
      orderBy: { createdAt: "desc" }
    });

    if (existingPending) {
      return NextResponse.json(
        {
          status: "pending",
          id: existingPending.id,
          email,
          role,
          expiresAt: existingPending.expiresAt,
          inviteUrl: buildInviteUrlForInvitation(existingPending.id),
          delivery: existingPending.deliveryStatus,
          message: "A pending invitation already exists for this email."
        },
        { status: 202 }
      );
    }

    const tokenHash = hashInviteToken(createInviteToken());
    const expiresAt = getInviteExpiryDate();

    const invitation = await db.invitation.create({
      data: {
        organizationId,
        email,
        role,
        tokenHash,
        inviteType: "organization",
        invitedById: session.user.id,
        expiresAt
      },
      select: {
        id: true,
        email: true,
        role: true,
        organization: { select: { name: true } },
        expiresAt: true
      }
    });

    const stableToken = createInviteTokenForInvitation(invitation.id);
    const stableTokenHash = hashInviteToken(stableToken);
    await db.invitation.update({
      where: { id: invitation.id },
      data: { tokenHash: stableTokenHash }
    });

    const inviteUrl = buildInviteUrlForInvitation(invitation.id);
    const emailConfigured = isSmtpConfigured();
    let delivery: "not_configured" | "sent" | "failed" = "not_configured";
    let deliveryError: string | null = null;

    if (emailConfigured) {
      const emailResult = await sendInviteEmail({
        to: email,
        inviteUrl,
        expiresAt,
        scopeLabel: `client ${invitation.organization.name}`,
        role
      });
      delivery = emailResult.sent ? "sent" : "failed";
      deliveryError = emailResult.error ?? null;

      await db.invitation.update({
        where: { id: invitation.id },
        data: {
          deliveryStatus: delivery,
          deliveryError,
          sentAt: emailResult.sent ? new Date() : null
        }
      });
    }

    return NextResponse.json(
      {
        status: "pending",
        id: invitation.id,
        email: invitation.email,
        role: normalizeRole(invitation.role),
        expiresAt: invitation.expiresAt,
        inviteUrl,
        delivery,
        emailDeliveryConfigured: emailConfigured,
        message: emailConfigured
          ? "Invitation created and email sent."
          : "Email delivery not configured yet - copy this invite link manually."
      },
      { status: 202 }
    );
  } catch (err) {
    console.error("POST /api/organizations/[id]/collaborators error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
