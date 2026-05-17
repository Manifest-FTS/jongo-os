import { NextResponse } from "next/server";
import { hashInviteToken, isInviteExpired, parseInvitationIdFromToken } from "@/lib/invitations";
import { normalizeRole } from "@/lib/roles";

type Params = { params: Promise<{ token: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { token } = await params;

  try {
    const { db } = await import("@/lib/db");
    const tokenHash = hashInviteToken(token);

    let invite = await db.invitation.findUnique({
      where: { tokenHash },
      include: {
        organization: { select: { id: true, name: true } },
        site: { select: { id: true, name: true } },
        invitedBy: { select: { fullName: true, email: true } }
      }
    });

    if (!invite) {
      const invitationId = parseInvitationIdFromToken(token);
      if (invitationId) {
        invite = await db.invitation.findUnique({
          where: { id: invitationId },
          include: {
            organization: { select: { id: true, name: true } },
            site: { select: { id: true, name: true } },
            invitedBy: { select: { fullName: true, email: true } }
          }
        });
      }
    }

    if (!invite) {
      return NextResponse.json({ valid: false, state: "not_found" }, { status: 404 });
    }

    if (invite.revokedAt) {
      return NextResponse.json({ valid: false, state: "revoked" }, { status: 410 });
    }

    if (invite.acceptedAt) {
      return NextResponse.json({ valid: false, state: "used" }, { status: 410 });
    }

    if (isInviteExpired(invite.expiresAt)) {
      return NextResponse.json({ valid: false, state: "expired" }, { status: 410 });
    }

    const inviteEmail = invite.email.trim().toLowerCase();
    const existingUser = await db.user.findFirst({
      where: {
        email: {
          equals: inviteEmail,
          mode: "insensitive"
        }
      },
      select: { id: true }
    });

    let redirectTo = "/dashboard";
    if (invite.inviteType === "site" && invite.siteId) {
      redirectTo = `/apps/${invite.siteId}`;
    } else if (invite.inviteType === "organization") {
      redirectTo = `/clients/${invite.organizationId}`;
    }

    return NextResponse.json({
      valid: true,
      invite: {
        email: inviteEmail,
        role: normalizeRole(invite.role),
        inviteType: invite.inviteType,
        expiresAt: invite.expiresAt,
        organizationName: invite.organization.name,
        siteName: invite.site?.name ?? null,
        inviterName: invite.invitedBy?.fullName || invite.invitedBy?.email || invite.organization.name,
        existingUser: Boolean(existingUser),
        redirectTo
      }
    });
  } catch (error) {
    console.error("GET /api/invites/[token] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
