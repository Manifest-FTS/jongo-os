import { getDb } from "@/lib/db";
import { evaluateCmsEntitlement, type CmsSponsorState } from "@/lib/cms/entitlements";
import { isPlatformAdminUser } from "@/lib/rbac";
import { isUuid } from "@/lib/site-identity";
import { writeOidcAudit } from "@/lib/oidc/audit";

/**
 * Per-app Craft access for "Sign in with Jongo".
 *
 * Effective role for (user, site) is the highest of:
 *   - platform admin (isPlatformAdminUser)  -> admin   (implicit; always audited at token issuance)
 *   - organization owner                    -> admin
 *   - live organization admin (Collaborator.role = admin, the same test isClientAdmin uses) -> admin
 *   - an active SiteCraftAccess grant       -> its role
 * Anyone else, including an organization or app collaborator with no explicit grant, has NO access.
 * Deleted users, deleted sites, deleted organizations and a deleted organization owner deny everything.
 *
 * Entitlement follows evaluateCmsEntitlement exactly as dataset-access.ts uses it: read capacity
 * must exist, and without an active owner subscription ("cms.author") the role is capped to reader.
 */

export type CraftRole = "reader" | "editor" | "publisher" | "admin";
export type CraftAccessVia = "platform_admin" | "org_owner" | "org_admin" | "site_grant";

export const CRAFT_ROLES: readonly CraftRole[] = ["reader", "editor", "publisher", "admin"];
const RANK: Record<CraftRole, number> = { reader: 0, editor: 1, publisher: 2, admin: 3 };
// On equal roles, report the tenant-derived reason so "platform_admin" only appears when it was needed.
const VIA_PREFERENCE: CraftAccessVia[] = ["org_owner", "org_admin", "site_grant", "platform_admin"];

export function isCraftRole(value: unknown): value is CraftRole {
  return typeof value === "string" && (CRAFT_ROLES as readonly string[]).includes(value);
}

export type CraftAccessResult = {
  role: CraftRole;
  via: CraftAccessVia;
  /** True when the role was reduced to reader because the owner's subscription cannot author. */
  capped: boolean;
  siteId: string;
  organizationId: string;
  user: { id: string; email: string; emailVerified: boolean; name: string | null };
};

type Snapshot = {
  user: { id: string; email: string; emailVerified: boolean; fullName: string | null; deletedAt: Date | null };
  site: {
    id: string;
    organizationId: string;
    deletedAt: Date | null;
    organization: {
      id: string;
      ownerId: string;
      deletedAt: Date | null;
      owner: CmsSponsorState | null;
      collaborators: Array<{ userId: string; role: string; deletedAt: Date | null }>;
    } | null;
  };
  grant: { role: string } | null;
};

async function loadSnapshot(tx: any, userId: string, siteId: string): Promise<Snapshot | null> {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, emailVerified: true, fullName: true, deletedAt: true }
  });
  if (!user || user.deletedAt) return null;
  const site = await tx.site.findUnique({
    where: { id: siteId },
    select: {
      id: true, organizationId: true, deletedAt: true,
      organization: { select: {
        id: true, ownerId: true, deletedAt: true,
        owner: { select: {
          id: true, deletedAt: true, subscriptionPlanId: true,
          subscriptionStatus: true, subscriptionCurrentPeriodEnd: true
        } },
        collaborators: { where: { userId, deletedAt: null }, select: { userId: true, role: true, deletedAt: true } }
      } }
    }
  });
  if (!site || site.id !== siteId || site.deletedAt) return null;
  const org = site.organization;
  if (!org || org.id !== site.organizationId || org.deletedAt) return null;
  const grant = await tx.siteCraftAccess.findFirst({ where: { siteId, userId, revokedAt: null }, select: { role: true } });
  return { user, site, grant };
}

function isOrgAdmin(snapshot: Snapshot, userId: string): boolean {
  return snapshot.site.organization!.collaborators.some((c) => c.userId === userId && c.deletedAt === null && c.role === "admin");
}

function candidates(snapshot: Snapshot, userId: string, platformAdmin: boolean): Array<{ role: CraftRole; via: CraftAccessVia }> {
  const list: Array<{ role: CraftRole; via: CraftAccessVia }> = [];
  if (snapshot.site.organization!.ownerId === userId) list.push({ role: "admin", via: "org_owner" });
  if (isOrgAdmin(snapshot, userId)) list.push({ role: "admin", via: "org_admin" });
  if (snapshot.grant && isCraftRole(snapshot.grant.role)) list.push({ role: snapshot.grant.role, via: "site_grant" });
  if (platformAdmin) list.push({ role: "admin", via: "platform_admin" });
  return list;
}

function best(list: Array<{ role: CraftRole; via: CraftAccessVia }>) {
  return [...list].sort((a, b) =>
    RANK[b.role] - RANK[a.role] || VIA_PREFERENCE.indexOf(a.via) - VIA_PREFERENCE.indexOf(b.via))[0] ?? null;
}

/** Server entry point: reads live rows every call, never caches, denies on any error. */
export async function resolveCraftAccess(userId: string, siteId: string, now: Date = new Date()): Promise<CraftAccessResult | null> {
  if (typeof userId !== "string" || typeof siteId !== "string" || !isUuid(userId) || !isUuid(siteId)) return null;
  try {
    const db = await getDb();
    if (!db) return null;
    const snapshot: Snapshot | null = await db.$transaction(
      (tx: unknown) => loadSnapshot(tx, userId, siteId),
      { isolationLevel: "RepeatableRead" }
    );
    if (!snapshot) return null;
    const org = snapshot.site.organization!;

    const selected = best(candidates(snapshot, userId, await isPlatformAdminUser(userId)));
    if (!selected) return null;

    const permits = (feature: "cms.read" | "cms.author") => evaluateCmsEntitlement({
      feature, organizationId: org.id, sponsor: org.owner,
      scope: { organizationId: org.id, ownerId: org.ownerId, userId: org.ownerId, role: "owner" },
      enabled: process.env.JONGO_CMS_ENABLED === "true", now
    });
    if (!permits("cms.read")) return null;
    const capped = !permits("cms.author") && selected.role !== "reader";

    return {
      role: capped ? "reader" : selected.role,
      via: selected.via,
      capped,
      siteId,
      organizationId: org.id,
      user: {
        id: snapshot.user.id,
        email: snapshot.user.email,
        emailVerified: snapshot.user.emailVerified === true,
        name: snapshot.user.fullName ?? null
      }
    };
  } catch {
    return null;
  }
}

/** Platform admin, organization owner or live organization admin. App collaborators never manage grants. */
export type CraftManagerCapacity = "platform_admin" | "org_owner" | "org_admin";

/** The one definition of who may manage Craft access; app-level collaborators (even site admins) are never managers. */
export function craftManagerCapacity(input: { userId: string; ownerId: string; orgRole: unknown; isPlatformAdmin: boolean }): CraftManagerCapacity | null {
  if (input.ownerId === input.userId) return "org_owner";
  if (input.orgRole === "admin") return "org_admin";
  return input.isPlatformAdmin ? "platform_admin" : null;
}

async function managerCapacity(actorId: string, snapshot: Snapshot | null): Promise<CraftManagerCapacity | null> {
  if (!snapshot) return null;
  const tenant = craftManagerCapacity({
    userId: actorId, ownerId: snapshot.site.organization!.ownerId,
    orgRole: isOrgAdmin(snapshot, actorId) ? "admin" : null, isPlatformAdmin: false
  });
  if (tenant) return tenant;
  return craftManagerCapacity({ userId: actorId, ownerId: "", orgRole: null, isPlatformAdmin: await isPlatformAdminUser(actorId) });
}

/**
 * Highest role a manager may hand out: never more than they hold themselves. Every manager capacity holds admin on
 * the site (see candidates()), so today the ceiling is admin; keeping it explicit means a future lower tier of
 * manager cannot silently gain the ability to mint admins.
 */
export function grantCeiling(capacity: CraftManagerCapacity): CraftRole {
  switch (capacity) {
    case "platform_admin":
    case "org_owner":
    case "org_admin":
      return "admin";
  }
}

async function canManage(actorId: string, snapshot: Snapshot | null): Promise<boolean> {
  return (await managerCapacity(actorId, snapshot)) !== null;
}

export type CraftAccessFailure = "invalid" | "forbidden" | "not_found" | "unavailable";
export type CraftAccessContext = { ipAddress?: string | null; userAgent?: string | null };

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

export type GrantCraftAccessInput = CraftAccessContext & {
  actorId: string; siteId: string; userId: string; role: unknown;
  /** Set when the grant is applied from an accepted invitation (audit provenance only). */
  invitationId?: string;
};

export async function grantCraftAccess(input: GrantCraftAccessInput): Promise<{ ok: true; id: string; created: boolean } | { ok: false; reason: CraftAccessFailure }> {
  if (!isUuid(input.actorId) || !isUuid(input.siteId) || !isUuid(input.userId) || !isCraftRole(input.role)) return { ok: false, reason: "invalid" };
  const role = input.role;
  const db = await getDb();
  if (!db) return { ok: false, reason: "unavailable" };

  const attempt = () => db.$transaction(async (tx: any) => {
    const snapshot = await loadSnapshot(tx, input.actorId, input.siteId);
    if (!snapshot) return { ok: false as const, reason: "not_found" as const };
    const capacity = await managerCapacity(input.actorId, snapshot);
    if (!capacity || RANK[role] > RANK[grantCeiling(capacity)]) return { ok: false as const, reason: "forbidden" as const };
    const target = await tx.user.findUnique({ where: { id: input.userId }, select: { id: true, deletedAt: true } });
    if (!target || target.deletedAt) return { ok: false as const, reason: "not_found" as const };

    const existing = await tx.siteCraftAccess.findFirst({ where: { siteId: input.siteId, userId: input.userId, revokedAt: null }, select: { id: true } });
    let id: string;
    if (existing) {
      await tx.siteCraftAccess.update({ where: { id: existing.id }, data: { role, grantedByUserId: input.actorId } });
      id = existing.id;
    } else {
      const created = await tx.siteCraftAccess.create({
        data: { siteId: input.siteId, userId: input.userId, role, grantedByUserId: input.actorId },
        select: { id: true }
      });
      id = created.id;
    }
    await writeOidcAudit(tx, {
      organizationId: snapshot.site.organizationId, actorId: input.actorId, action: "craft.access.grant",
      resourceType: "site", resourceId: input.siteId,
      details: {
        targetUserId: input.userId, role, replaced: Boolean(existing),
        ...(input.invitationId ? { via: "invite", invitationId: input.invitationId } : {})
      },
      ipAddress: input.ipAddress, userAgent: input.userAgent
    });
    return { ok: true as const, id, created: !existing };
  });

  try {
    return await attempt();
  } catch (error) {
    // Two concurrent grants for the same pair: the partial unique index rejects one; retry as an update.
    if (isUniqueViolation(error)) {
      try { return await attempt(); } catch { return { ok: false, reason: "unavailable" }; }
    }
    return { ok: false, reason: "unavailable" };
  }
}

export type RevokeCraftAccessInput = CraftAccessContext & { actorId: string; siteId: string; userId: string };

export async function revokeCraftAccess(input: RevokeCraftAccessInput): Promise<{ ok: true; revoked: boolean } | { ok: false; reason: CraftAccessFailure }> {
  if (!isUuid(input.actorId) || !isUuid(input.siteId) || !isUuid(input.userId)) return { ok: false, reason: "invalid" };
  try {
    const db = await getDb();
    if (!db) return { ok: false, reason: "unavailable" };
    return await db.$transaction(async (tx: any) => {
      const snapshot = await loadSnapshot(tx, input.actorId, input.siteId);
      if (!snapshot) return { ok: false as const, reason: "not_found" as const };
      if (!(await canManage(input.actorId, snapshot))) return { ok: false as const, reason: "forbidden" as const };
      const changed = await tx.siteCraftAccess.updateMany({
        where: { siteId: input.siteId, userId: input.userId, revokedAt: null },
        data: { revokedAt: new Date() }
      });
      if (changed.count > 0) {
        await writeOidcAudit(tx, {
          organizationId: snapshot.site.organizationId, actorId: input.actorId, action: "craft.access.revoke",
          resourceType: "site", resourceId: input.siteId, details: { targetUserId: input.userId },
          ipAddress: input.ipAddress, userAgent: input.userAgent
        });
      }
      return { ok: true as const, revoked: changed.count > 0 };
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

export type CraftAccessEntry = {
  id: string; userId: string; email: string; name: string | null; role: CraftRole;
  grantedByUserId: string | null; createdAt: Date; updatedAt: Date;
};

export async function listCraftAccess(actorId: string, siteId: string): Promise<{ ok: true; entries: CraftAccessEntry[] } | { ok: false; reason: CraftAccessFailure }> {
  if (!isUuid(actorId) || !isUuid(siteId)) return { ok: false, reason: "invalid" };
  try {
    const db = await getDb();
    if (!db) return { ok: false, reason: "unavailable" };
    return await db.$transaction(async (tx: any) => {
      const snapshot = await loadSnapshot(tx, actorId, siteId);
      if (!snapshot) return { ok: false as const, reason: "not_found" as const };
      if (!(await canManage(actorId, snapshot))) return { ok: false as const, reason: "forbidden" as const };
      const rows: Array<{ id: string; userId: string; role: string; grantedByUserId: string | null; createdAt: Date; updatedAt: Date; user: { email: string; fullName: string | null; deletedAt: Date | null } }> =
        await tx.siteCraftAccess.findMany({
          where: { siteId, revokedAt: null },
          orderBy: { createdAt: "asc" },
          select: { id: true, userId: true, role: true, grantedByUserId: true, createdAt: true, updatedAt: true, user: { select: { email: true, fullName: true, deletedAt: true } } }
        });
      return {
        ok: true as const,
        entries: rows.filter((row) => row.user.deletedAt === null && isCraftRole(row.role)).map((row) => ({
          id: row.id, userId: row.userId, email: row.user.email, name: row.user.fullName,
          role: row.role as CraftRole, grantedByUserId: row.grantedByUserId, createdAt: row.createdAt, updatedAt: row.updatedAt
        }))
      };
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
