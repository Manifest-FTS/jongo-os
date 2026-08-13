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

type Params = { params: Promise<{ siteId: string; invitationId: string }> };

type Body = {
  action?: "resend" | "regenerate" | "revoke";
};

type Access = {
  siteId: string;
  siteName: string;
  orgId: string;
  isAdmin: boolean;
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

async function getAccess(siteId: string, userId: string): Promise<Access | null> {
  const { db } = await import("@/lib/db");
  const site = await db.site.findFirst({
    where: {
      ...buildSiteIdentityWhere(siteId),
      deletedAt: null,
      OR: [
        {
          organization: {
            deletedAt: null,
            OR: [{ ownerId: userId }, { collaborators: { some: { userId, deletedAt: null } } }]
          }
        },
        { collaborators: { some: { userId, deletedAt: null } } }
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

  if (!site) return null;

  const orgAdmin = site.organization.ownerId === userId || isAdminRole(site.organization.collaborators[0]?.role);
  const siteAdmin = isAdminRole(site.collaborators[0]?.role);

  return {
    siteId: site.id,
    siteName: site.name,
    orgId: site.organization.id,
    isAdmin: orgAdmin || siteAdmin
  };
}

export async function POST(req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { siteId, invitationId } = await params;

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.action || !["resend", "regenerate", "revoke"].includes(body.action)) {
    return NextResponse.json({ error: "action must be resend, regenerate, or revoke" }, { status: 400 });
  }

  const access = await getAccess(siteId, session.user.id);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!access.isAdmin) {
    return NextResponse.json({ error: "Only admins can manage invites" }, { status: 403 });
  }

  try {
    const { db } = await import("@/lib/db");
    const invite = await db.invitation.findFirst({
      where: {
        id: invitationId,
        siteId: access.siteId,
        inviteType: "site"
      }
    });

    if (!invite) {
      return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
    }

    const status = getInvitationStatus(invite);

    if (body.action === "revoke") {
      if (status === "accepted") {
        return NextResponse.json({ error: "Accepted invites cannot be revoked" }, { status: 409 });
      }

      if (status !== "revoked") {
        await db.invitation.update({
          where: { id: invite.id },
          data: { revokedAt: new Date() }
        });
      }

      return NextResponse.json({ ok: true, status: "revoked", id: invite.id });
    }

    if (body.action === "resend") {
      if (status !== "pending") {
        return NextResponse.json({ error: `Only pending invites can be resent (current: ${status})` }, { status: 409 });
      }

      const inviteUrl = buildInviteUrlForInvitation(invite.id);
      const emailConfigured = isSmtpConfigured();
      if (!emailConfigured) {
        return NextResponse.json({
          ok: true,
          status,
          inviteUrl,
          emailDeliveryConfigured: false,
          message: "Email delivery not configured yet - copy this invite link manually."
        });
      }

      const emailResult = await sendInviteEmail({
        to: invite.email,
        inviteUrl,
        expiresAt: invite.expiresAt,
        scopeLabel: `app ${access.siteName}`,
        role: normalizeRole(invite.role)
      });

      await db.invitation.update({
        where: { id: invite.id },
        data: {
          deliveryStatus: emailResult.sent ? "sent" : "failed",
          deliveryError: emailResult.error ?? null,
          sentAt: emailResult.sent ? new Date() : null
        }
      });

      return NextResponse.json({
        ok: emailResult.sent,
        status,
        inviteUrl,
        emailDeliveryConfigured: true,
        delivery: emailResult.sent ? "sent" : "failed",
        error: emailResult.error ?? null
      });
    }

    if (status === "accepted") {
      return NextResponse.json({ error: "Accepted invites cannot be regenerated" }, { status: 409 });
    }

    const existingActive = await db.invitation.findFirst({
      where: {
        siteId: access.siteId,
        inviteType: "site",
        email: invite.email,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        id: { not: invite.id }
      },
      orderBy: { createdAt: "desc" }
    });

    if (existingActive) {
      return NextResponse.json({
        ok: true,
        id: existingActive.id,
        status: "pending",
        inviteUrl: buildInviteUrlForInvitation(existingActive.id),
        message: "A pending invitation already exists for this email."
      });
    }

    if (!invite.revokedAt) {
      await db.invitation.update({
        where: { id: invite.id },
        data: { revokedAt: new Date() }
      });
    }

    const created = await db.invitation.create({
      data: {
        organizationId: access.orgId,
        siteId: access.siteId,
        email: invite.email,
        role: normalizeRole(invite.role),
        inviteType: "site",
        invitedById: session.user.id,
        expiresAt: getInviteExpiryDate(),
        tokenHash: hashInviteToken(createInviteToken())
      },
      select: {
        id: true,
        email: true,
        role: true,
        expiresAt: true
      }
    });

    const stableToken = createInviteTokenForInvitation(created.id);
    await db.invitation.update({
      where: { id: created.id },
      data: { tokenHash: hashInviteToken(stableToken) }
    });

    const inviteUrl = buildInviteUrlForInvitation(created.id);
    const emailConfigured = isSmtpConfigured();
    let delivery: "not_configured" | "sent" | "failed" = "not_configured";
    let deliveryError: string | null = null;

    if (emailConfigured) {
      const emailResult = await sendInviteEmail({
        to: created.email,
        inviteUrl,
        expiresAt: created.expiresAt,
        scopeLabel: `app ${access.siteName}`,
        role: normalizeRole(created.role)
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

    return NextResponse.json({
      ok: true,
      id: created.id,
      status: "pending",
      inviteUrl,
      delivery,
      emailDeliveryConfigured: emailConfigured,
      message: emailConfigured
        ? "New invitation created and email sent."
        : "New invitation created. Copy this invite link manually."
    });
  } catch (error) {
    console.error("POST /api/sites/[siteId]/collaborators/invitations/[invitationId] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
