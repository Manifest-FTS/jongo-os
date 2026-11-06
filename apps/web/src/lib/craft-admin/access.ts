import { getDb } from "@/lib/db";
import { grantCraftAccess, listCraftAccess, type CraftRole } from "@/lib/craft-access";
import { writeOidcAuditBestEffort } from "@/lib/oidc/audit";
import { isOidcEnabled } from "@/lib/oidc/config";
import { getPlatformAdminContacts } from "@/lib/permissions";
import { isUuid } from "@/lib/site-identity";
import { inheritedLabel, type InheritedSource } from "./shared";

type Person = { email: string; name: string | null };

export type ExplicitAccessRow = {
  userId: string; email: string; name: string | null; role: CraftRole;
  grantedBy: Person | null; createdAt: Date; updatedAt: Date;
};

export type InheritedAccessRow = {
  source: InheritedSource; label: string; role: "admin";
  /** Null for the platform-admin row, which is a group; `contacts` names the people. */
  userId: string | null; email: string | null; name: string | null; contacts?: string[];
};

export type CraftAccessOverview = { explicit: ExplicitAccessRow[]; inherited: InheritedAccessRow[] };

type Site = { id: string; organizationId: string };

/** Explicit grants plus the read-only access that comes from the client team and from Jongo itself. */
export async function getCraftAccessOverview(actorId: string, site: Site): Promise<{ ok: true; overview: CraftAccessOverview } | { ok: false; reason: string }> {
  const listed = await listCraftAccess(actorId, site.id);
  if (!listed.ok) return { ok: false, reason: listed.reason };
  const db = await getDb();
  if (!db) return { ok: false, reason: "unavailable" };

  const grantorIds = [...new Set(listed.entries.map((entry) => entry.grantedByUserId).filter((id): id is string => Boolean(id)))];
  const [grantors, organization, contacts] = await Promise.all([
    grantorIds.length > 0 ? db.user.findMany({ where: { id: { in: grantorIds } }, select: { id: true, email: true, fullName: true } }) : Promise.resolve([]),
    db.organization.findFirst({
      where: { id: site.organizationId, deletedAt: null },
      select: {
        owner: { select: { id: true, email: true, fullName: true, deletedAt: true } },
        collaborators: { where: { role: "admin", deletedAt: null }, select: { user: { select: { id: true, email: true, fullName: true, deletedAt: true } } } }
      }
    }),
    getPlatformAdminContacts().catch(() => [] as string[])
  ]);
  const grantorById = new Map<string, Person>((grantors as Array<{ id: string; email: string; fullName: string | null }>).map((u) => [u.id, { email: u.email, name: u.fullName }]));

  const inherited: InheritedAccessRow[] = [
    { source: "platform_admin", label: inheritedLabel("platform_admin"), role: "admin", userId: null, email: null, name: null, contacts }
  ];
  const seen = new Set<string>();
  const push = (source: InheritedSource, user: { id: string; email: string; fullName: string | null; deletedAt: Date | null } | null) => {
    if (!user || user.deletedAt || seen.has(user.id)) return;
    seen.add(user.id);
    inherited.push({ source, label: inheritedLabel(source), role: "admin", userId: user.id, email: user.email, name: user.fullName });
  };
  push("org_owner", organization?.owner ?? null);
  for (const member of (organization?.collaborators ?? []) as Array<{ user: any }>) push("org_admin", member.user);

  return {
    ok: true,
    overview: {
      explicit: listed.entries.map((entry) => ({
        userId: entry.userId, email: entry.email, name: entry.name, role: entry.role,
        grantedBy: entry.grantedByUserId ? grantorById.get(entry.grantedByUserId) ?? null : null,
        createdAt: entry.createdAt, updatedAt: entry.updatedAt
      })),
      inherited
    }
  };
}

export type GrantTarget = { ok: true; userId: string } | { ok: false; status: 400 | 404; error: string };

/**
 * Who may receive a grant: any live Jongo user, looked up by email, or an id of someone who already belongs
 * to this client/app (or already holds a grant here). A client-supplied id never reaches a stranger.
 */
export async function resolveGrantTarget(site: Site, input: { email?: string; userId?: string }): Promise<GrantTarget> {
  const db = await getDb();
  if (!db) return { ok: false, status: 404, error: "Unavailable" };
  if (input.email) {
    const user = await db.user.findFirst({ where: { email: { equals: input.email, mode: "insensitive" }, deletedAt: null }, select: { id: true } });
    return user ? { ok: true, userId: user.id } : { ok: false, status: 404, error: "No Jongo user has that email address. Invite them to the app first." };
  }
  if (!input.userId || !isUuid(input.userId)) return { ok: false, status: 400, error: "userId must be a UUID" };
  const userId = input.userId;
  const [organization, orgMember, siteMember, granted] = await Promise.all([
    db.organization.findFirst({ where: { id: site.organizationId, deletedAt: null }, select: { ownerId: true } }),
    db.collaborator.findFirst({ where: { organizationId: site.organizationId, userId, deletedAt: null }, select: { id: true } }),
    db.siteCollaborator.findFirst({ where: { siteId: site.id, userId, deletedAt: null }, select: { id: true } }),
    db.siteCraftAccess.findFirst({ where: { siteId: site.id, userId, revokedAt: null }, select: { id: true } })
  ]);
  const member = organization?.ownerId === userId || orgMember || siteMember || granted;
  return member ? { ok: true, userId } : { ok: false, status: 404, error: "That person is not a member of this client." };
}

/** Remember the Craft role picked while inviting; applied on accept, after the inviter is re-checked. */
export async function rememberInviteCraftRole(db: any, invitationId: string, role: CraftRole): Promise<void> {
  await db.invitationCraftAccess.upsert({ where: { invitationId }, create: { invitationId, role }, update: { role } });
}

export async function loadInviteCraftRoles(db: any, invitationIds: string[]): Promise<Map<string, CraftRole>> {
  if (invitationIds.length === 0) return new Map();
  const rows: Array<{ invitationId: string; role: CraftRole }> = await db.invitationCraftAccess.findMany({
    where: { invitationId: { in: invitationIds } }, select: { invitationId: true, role: true }
  });
  return new Map(rows.map((row) => [row.invitationId, row.role]));
}

export type InviteApplyOutcome = { status: "disabled" | "none" } | { status: "applied"; role: CraftRole } | { status: "skipped"; reason: string };

/**
 * Called after an app invitation was accepted. Re-verifies the INVITER at acceptance time (grantCraftAccess checks that the
 * actor is still owner/admin/platform admin), so a demoted or removed inviter cannot hand out Craft access through an old invite.
 * Never throws: accepting the invite must not fail because of Craft.
 */
export async function applyInviteCraftAccess(invitation: { id: string; organizationId: string; siteId: string | null; invitedById: string | null }, userId: string, meta: { ipAddress?: string | null; userAgent?: string | null } = {}): Promise<InviteApplyOutcome> {
  if (!isOidcEnabled()) return { status: "disabled" };
  try {
    const db = await getDb();
    if (!db) return { status: "none" };
    const stored: { role: CraftRole } | null = await db.invitationCraftAccess.findUnique({ where: { invitationId: invitation.id }, select: { role: true } });
    if (!stored) return { status: "none" };
    const skip = async (reason: string): Promise<InviteApplyOutcome> => {
      await writeOidcAuditBestEffort(db, {
        organizationId: invitation.organizationId, actorId: invitation.invitedById, action: "craft.access.invite",
        resourceType: "site", resourceId: invitation.siteId ?? invitation.id,
        details: { invitationId: invitation.id, role: stored.role, targetUserId: userId, outcome: "skipped", reason },
        ipAddress: meta.ipAddress, userAgent: meta.userAgent
      });
      return { status: "skipped", reason };
    };
    if (!invitation.siteId || !invitation.invitedById) return skip("inviter_unavailable");
    const result = await grantCraftAccess({ actorId: invitation.invitedById, siteId: invitation.siteId, userId, role: stored.role, invitationId: invitation.id, ...meta });
    return result.ok ? { status: "applied", role: stored.role } : skip(result.reason === "forbidden" ? "inviter_no_longer_authorized" : result.reason);
  } catch {
    console.error("[craft-admin] applying invite Craft role failed");
    return { status: "skipped", reason: "error" };
  }
}
