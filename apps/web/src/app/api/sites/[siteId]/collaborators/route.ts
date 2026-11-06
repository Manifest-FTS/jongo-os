import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { isSmtpConfigured, sendInviteEmail } from "@/lib/email";
import {
  buildInviteUrlForInvitation,
  createInviteToken,
  createInviteTokenForInvitation,
  getInviteExpiryDate,
  hashInviteToken,
  isInviteExpired
} from "@/lib/invitations";
import { normalizeRole } from "@/lib/roles";
import { hasOnlyFields, isTenantMutationRole, resolveSiteAccess } from "@/lib/tenant-route-access";
import { getClientTeamMembers } from "@/lib/repositories";
import { getPlatformAdminContacts } from "@/lib/permissions";
import { isOidcEnabled } from "@/lib/oidc/config";
import { writeOidcAuditBestEffort } from "@/lib/oidc/audit";
import { grantCraftAccess, type CraftRole } from "@/lib/craft-access";
import { loadInviteCraftRoles, rememberInviteCraftRole } from "@/lib/craft-admin/access";
import { resolveCraftManager } from "@/lib/craft-admin/gate";
import { parseCraftRole } from "@/lib/craft-admin/validation";

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
  const access = await resolveSiteAccess(siteId, userId);
  if (!access) return null;
  return {
    siteId: access.site.id, siteName: access.site.name,
    orgId: access.site.organization.id, orgOwnerId: access.site.organization.ownerId,
    callerRole: access.isAdmin ? "admin" : "collaborator"
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

    // Feature flag off: no Craft query runs and the response has exactly the fields it always had.
    const craftOn = isOidcEnabled();
    const craftRoles = craftOn ? await loadInviteCraftRoles(db, pendingInvites.map((invite: any) => invite.id)) : null;
    const craftCanGrant = craftOn ? (await resolveCraftManager(session.user.id, access.siteId)).ok : false;

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
        note: invite.deliveryError ?? null,
        ...(craftRoles ? { craftRole: craftRoles.get(invite.id) ?? null } : {})
      })),
      emailDeliveryConfigured: isSmtpConfigured(),
      callerRole: access.callerRole,
      ...(craftOn ? { craftEnabled: true, craftCanGrant } : {})
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

  let body: { email?: string; role?: string; forceInvite?: boolean; craftRole?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // With the Craft flag off the accepted field set is exactly what it was before, so `craftRole` is rejected like any unknown field.
  const craftOn = isOidcEnabled();
  if (!hasOnlyFields(body, craftOn ? ["email", "role", "forceInvite", "craftRole"] : ["email", "role", "forceInvite"]) || !isTenantMutationRole(body.role)) {
    return NextResponse.json({ error: "role must be admin or collaborator" }, { status: 400 });
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const requestedRole = normalizeRole(body.role);
  const forceInvite = body.forceInvite === true;

  if (!email) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }

  // null/undefined/"none" = no Craft access (the default).
  let craftRole: CraftRole | null = null;
  if (craftOn && body.craftRole !== undefined && body.craftRole !== null && body.craftRole !== "none") {
    const parsedCraftRole = parseCraftRole(body.craftRole);
    if (!parsedCraftRole.ok) return NextResponse.json({ error: parsedCraftRole.error }, { status: 400 });
    craftRole = parsedCraftRole.value;
  }

  try {
    const access = await getCallerAccess(siteId, session.user.id);
    if (!access) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (access.callerRole !== "admin" && requestedRole === "admin") {
      return NextResponse.json({ error: "Only admins can invite admins" }, { status: 403 });
    }

    // Craft access is a bigger decision than app membership: only the owner, client admins and platform admins may attach it.
    // Site-level admins and collaborators are refused before anything is written.
    if (craftRole) {
      const manager = await resolveCraftManager(session.user.id, access.siteId);
      if (!manager.ok) {
        return NextResponse.json({ error: "Only the client owner or admins can grant Jongo Craft access" }, { status: manager.status });
      }
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

      // The user exists, so the Craft grant applies now (it re-verifies the caller and audits itself).
      const craftGrant = craftRole
        ? await grantCraftAccess({
            actorId: session.user.id, siteId: access.siteId, userId: targetUser.id, role: craftRole,
            ipAddress: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null, userAgent: req.headers.get("user-agent")
          })
        : null;

      return NextResponse.json(
        {
          status: "active",
          id: created.id,
          userId: created.userId,
          role: normalizeRole(created.role),
          email: created.user.email,
          fullName: created.user.fullName,
          ...(craftRole ? { craftAccess: { role: craftRole, applied: Boolean(craftGrant?.ok) } } : {})
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
      if (craftRole) {
        await rememberInviteCraftRole(db, activePending.id, craftRole);
        await writeOidcAuditBestEffort(db, {
          organizationId: access.orgId, actorId: session.user.id, action: "craft.access.invite", resourceType: "site", resourceId: access.siteId,
          details: { invitationId: activePending.id, role: craftRole, outcome: "updated" }
        });
      }
      return NextResponse.json(
        {
          status: "pending",
          id: activePending.id,
          email,
          role: normalizeRole(activePending.role),
          expiresAt: activePending.expiresAt,
          inviteUrl: buildInviteUrlForInvitation(activePending.id),
          message: "A pending invite already exists for this email.",
          ...(craftRole ? { craftRole } : {})
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

    if (craftRole) {
      await rememberInviteCraftRole(db, created.id, craftRole);
      await writeOidcAuditBestEffort(db, {
        organizationId: access.orgId, actorId: session.user.id, action: "craft.access.invite", resourceType: "site", resourceId: access.siteId,
        details: { invitationId: created.id, role: craftRole, outcome: "created" }
      });
    }

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
          : "Email delivery not configured yet - copy this invite link manually.",
        ...(craftRole ? { craftRole } : {})
      },
      { status: 202 }
    );
  } catch (error) {
    console.error("POST /api/sites/[siteId]/collaborators error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
