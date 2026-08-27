import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { buildSiteIdentityWhere } from "@/lib/site-identity";
import { isSmtpConfigured, sendInviteEmail } from "@/lib/email";
import {
  buildInviteUrlForInvitation,
  createInviteToken,
  createInviteTokenForInvitation,
  getInviteExpiryDate,
  hashInviteToken,
  isInviteExpired
} from "@/lib/invitations";
import { isAdminRole, normalizeRole } from "@/lib/roles";
import { getClientTeamMembers } from "@/lib/repositories";
import { getPlatformAdminContacts } from "@/lib/permissions";

type Params = { params: Promise<{ siteId: string }> };

type CallerAccess = {
  siteId: string;
  siteName: string;
  orgId: string;
  orgOwnerId: string;
  callerRole: "admin" | "collaborator";
};

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

async function getCallerAccess(siteId: string, userId: string): Promise<CallerAccess | null> {
  const { db } = await import("@/lib/db");

  const site = await db.site.findFirst({
    where: {
      AND: [
        {
          ...buildSiteIdentityWhere(siteId),
          deletedAt: null
        },
        {
          OR: [
            {
              organization: {
                deletedAt: null,
                OR: [{ ownerId: userId }, { collaborators: { some: { userId, deletedAt: null } } }]
              }
            },
            { collaborators: { some: { userId, deletedAt: null } } }
          ]
        }
      ]
    },
    select: {
      id: true,
      name: true,
      organization: {
        select: {
          id: true,
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
    siteName: site.name,
    orgId: site.organization.id,
    orgOwnerId: site.organization.ownerId,
    callerRole: orgAdmin || siteAdmin ? "admin" : "collaborator"
  };
}

export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { siteId } = await params;

  try {
    const access = await getCallerAccess(siteId, session.user.id);
    if (!access) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const { db } = await import("@/lib/db");
    const rows = await db.siteCollaborator.findMany({
      where: { siteId: access.siteId },
      include: { user: { select: { id: true, email: true, fullName: true } } },
      orderBy: { createdAt: "asc" }
    });

    // App-specific rows above are the legacy, per-app grant. Client team
    // members below are the ones who actually have access today, since access
    // now flows from the client/project level down to every app in it — a
    // card that only showed the (now usually empty) app-specific list looked
    // like nobody had access to an app its own client team could fully manage.
    const clientMembers = await getClientTeamMembers(access.orgId);
    const clientTeam = clientMembers.map((m) => ({
      id: m.id,
      userId: m.userId,
      role: m.role,
      email: m.email,
      fullName: m.name,
      isOwner: m.userId === access.orgOwnerId
    }));

    const pendingInvites = await db.invitation.findMany({
      where: {
        siteId: access.siteId,
        inviteType: "site"
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        role: true,
        acceptedAt: true,
        revokedAt: true,
        expiresAt: true,
        createdAt: true,
        deliveryStatus: true,
        deliveryError: true
      }
    });

    return NextResponse.json({
      collaborators: rows.map((row: any) => ({
        id: row.id,
        userId: row.userId,
        role: normalizeRole(row.role),
        email: row.user.email,
        fullName: row.user.fullName,
        createdAt: row.createdAt
      })),
      clientTeam,
      platformAdmins: await getPlatformAdminContacts(),
      pendingInvites: pendingInvites.map((invite: any) => ({
        id: invite.id,
        email: invite.email,
        role: normalizeRole(invite.role),
        status: getInvitationStatus(invite),
        inviteUrl: getInvitationStatus(invite) === "pending" ? buildInviteUrlForInvitation(invite.id) : null,
        acceptedAt: invite.acceptedAt,
        revokedAt: invite.revokedAt,
        expiresAt: invite.expiresAt,
        createdAt: invite.createdAt,
        delivery: invite.deliveryStatus,
        note: invite.deliveryError ?? null
      })),
      emailDeliveryConfigured: isSmtpConfigured(),
      callerRole: access.callerRole
    });
  } catch (error) {
    console.error("GET /api/sites/[siteId]/collaborators error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { siteId } = await params;

  let body: { email?: string; role?: string; forceInvite?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  const requestedRole = normalizeRole(body.role);
  const forceInvite = body.forceInvite === true;

  if (!email) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }

  try {
    const access = await getCallerAccess(siteId, session.user.id);
    if (!access) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (access.callerRole !== "admin" && requestedRole === "admin") {
      return NextResponse.json({ error: "Only admins can invite admins" }, { status: 403 });
    }

    const { db } = await import("@/lib/db");
    const targetUser = await db.user.findUnique({ where: { email } });

    if (targetUser && !forceInvite) {
      const existing = await db.siteCollaborator.findFirst({
        where: { siteId: access.siteId, userId: targetUser.id }
      });
      if (existing) {
        return NextResponse.json({ error: "That user is already on this app" }, { status: 409 });
      }

      const created = await db.siteCollaborator.create({
        data: {
          siteId: access.siteId,
          userId: targetUser.id,
          role: requestedRole
        },
        include: { user: { select: { id: true, email: true, fullName: true } } }
      });

      return NextResponse.json(
        {
          status: "active",
          id: created.id,
          userId: created.userId,
          role: normalizeRole(created.role),
          email: created.user.email,
          fullName: created.user.fullName
        },
        { status: 201 }
      );
    }

    const activePending = await db.invitation.findFirst({
      where: {
        siteId: access.siteId,
        inviteType: "site",
        email,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() }
      },
      orderBy: { createdAt: "desc" }
    });

    if (activePending) {
      return NextResponse.json(
        {
          status: "pending",
          id: activePending.id,
          email,
          role: normalizeRole(activePending.role),
          expiresAt: activePending.expiresAt,
          inviteUrl: buildInviteUrlForInvitation(activePending.id),
          message: "A pending invite already exists for this email."
        },
        { status: 202 }
      );
    }

    const tokenHash = hashInviteToken(createInviteToken());
    const expiresAt = getInviteExpiryDate();

    const created = await db.invitation.create({
      data: {
        organizationId: access.orgId,
        siteId: access.siteId,
        email,
        role: requestedRole,
        inviteType: "site",
        tokenHash,
        invitedById: session.user.id,
        expiresAt
      },
      select: {
        id: true,
        email: true,
        role: true,
        expiresAt: true
      }
    });

    const stableToken = createInviteTokenForInvitation(created.id);
    const stableTokenHash = hashInviteToken(stableToken);
    await db.invitation.update({
      where: { id: created.id },
      data: { tokenHash: stableTokenHash }
    });

    const inviteUrl = buildInviteUrlForInvitation(created.id);
    const emailConfigured = isSmtpConfigured();
    let delivery: "not_configured" | "sent" | "failed" = "not_configured";
    let deliveryError: string | null = null;

    if (emailConfigured) {
      const scopeLabel = `app ${access.siteName}`;
      const emailResult = await sendInviteEmail({
        to: email,
        inviteUrl,
        expiresAt,
        scopeLabel,
        role: requestedRole
      });

      delivery = emailResult.sent ? "sent" : "failed";
      deliveryError = emailResult.error ?? null;

      await db.invitation.update({
        where: { id: created.id },
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
        id: created.id,
        email: created.email,
        role: normalizeRole(created.role),
        expiresAt: created.expiresAt,
        inviteUrl,
        delivery,
        emailDeliveryConfigured: emailConfigured,
        message: emailConfigured
          ? "Invitation created and email sent."
          : "Email delivery not configured yet - copy this invite link manually."
      },
      { status: 202 }
    );
  } catch (error) {
    console.error("POST /api/sites/[siteId]/collaborators error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
