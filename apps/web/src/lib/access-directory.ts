import { getDb } from "@/lib/db";
import { isSuperAdminUser } from "@/lib/rbac";

export const ACCESS_DIRECTORY_PAGE_SIZE = 50;
const MAX_PAGE = 10_000;
const MAX_ACCESS_SCOPES_PER_USER = 20;

export type AccessDirectoryInput = {
  page?: number;
  q?: string;
  role?: string;
  invitePage?: number;
};

export type AccessDirectoryUser = {
  id: string;
  email: string;
  fullName: string | null;
  role: "super_admin" | "admin" | "collaborator";
  createdAt: Date;
  platformAccess: boolean;
  platformAccessSources: string[];
  ownedClients: Array<{ id: string; name: string; slug: string; appCount: number }>;
  clientMemberships: Array<{ id: string; name: string; slug: string; role: string; appCount: number }>;
  appMemberships: Array<{ id: string; name: string; slug: string; role: string; clientName: string; clientSlug: string }>;
  accessListsTruncated: boolean;
};

export type AccessDirectoryInvite = {
  id: string;
  email: string;
  role: string;
  inviteType: string;
  createdAt: Date;
  expiresAt: Date;
  organization: { id: string; name: string; slug: string };
  site: { id: string; name: string; slug: string } | null;
};

export type AccessDirectoryResult = {
  users: AccessDirectoryUser[];
  page: number;
  pageSize: number;
  totalUsers: number;
  hasMoreUsers: boolean;
  invitePage: number;
  invites: AccessDirectoryInvite[];
  totalInvites: number;
  hasMoreInvites: boolean;
  counts: Record<"super_admin" | "admin" | "collaborator", number>;
};

export class AccessDirectoryError extends Error {
  constructor(readonly status: 401 | 403 | 503, message: string) {
    super(message);
    this.name = "AccessDirectoryError";
  }
}

function boundedPage(value: number | undefined): number {
  return Number.isInteger(value) && value! >= 1 && value! <= MAX_PAGE ? value! : 1;
}

function normalizedRole(value: string | undefined): "super_admin" | "admin" | "collaborator" | null {
  return value === "super_admin" || value === "admin" || value === "collaborator" ? value : null;
}

/**
 * Platform-wide read-only view of registered users' effective access.
 * Re-authorizes against User.role on every request and selects no credentials,
 * billing fields, tokens, invitation hashes or provider secrets.
 */
export async function getAccessDirectory(userId: string | null | undefined, input: AccessDirectoryInput = {}): Promise<AccessDirectoryResult> {
  if (!userId) throw new AccessDirectoryError(401, "Sign in to continue.");
  if (!(await isSuperAdminUser(userId))) throw new AccessDirectoryError(403, "Super-admin access is required.");

  const db = await getDb();
  if (!db) throw new AccessDirectoryError(503, "The access directory is temporarily unavailable.");

  const page = boundedPage(input.page);
  const invitePage = boundedPage(input.invitePage);
  const pageSize = ACCESS_DIRECTORY_PAGE_SIZE;
  const q = typeof input.q === "string" ? input.q.trim().slice(0, 200) : "";
  const role = normalizedRole(input.role);
  const userWhere = {
    deletedAt: null,
    ...(role ? { role } : {}),
    ...(q ? { OR: [
      { email: { contains: q, mode: "insensitive" as const } },
      { fullName: { contains: q, mode: "insensitive" as const } }
    ] } : {})
  };
  const now = new Date();
  const inviteWhere = {
    acceptedAt: null,
    revokedAt: null,
    expiresAt: { gt: now },
    organization: { deletedAt: null },
    ...(q ? { OR: [
      { email: { contains: q, mode: "insensitive" as const } },
      { organization: { name: { contains: q, mode: "insensitive" as const } } },
      { site: { is: { name: { contains: q, mode: "insensitive" as const } } } }
    ] } : {})
  };

  const [users, totalUsers, invites, totalInvites, roleCounts] = await Promise.all([
    db.user.findMany({
      where: userWhere,
      orderBy: [{ email: "asc" }, { id: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        createdAt: true,
        platformAdminGrant: { select: { id: true } },
        organizations: {
          where: { deletedAt: null },
          orderBy: { name: "asc" },
          take: MAX_ACCESS_SCOPES_PER_USER,
          select: {
            id: true, name: true, slug: true,
            _count: { select: { sites: { where: { deletedAt: null } } } }
          }
        },
        collaborations: {
          where: { deletedAt: null, organization: { deletedAt: null } },
          orderBy: { organization: { name: "asc" } },
          take: MAX_ACCESS_SCOPES_PER_USER,
          select: {
            role: true,
            organization: {
              select: {
                id: true, name: true, slug: true,
                _count: { select: { sites: { where: { deletedAt: null } } } }
              }
            }
          }
        },
        siteCollaborations: {
          where: { deletedAt: null, site: { deletedAt: null, organization: { deletedAt: null } } },
          orderBy: { site: { name: "asc" } },
          take: MAX_ACCESS_SCOPES_PER_USER,
          select: {
            role: true,
            site: { select: { id: true, name: true, slug: true, organization: { select: { id: true, name: true, slug: true } } } }
          }
        }
      }
    }),
    db.user.count({ where: userWhere }),
    db.invitation.findMany({
      where: inviteWhere,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: (invitePage - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        email: true,
        role: true,
        inviteType: true,
        createdAt: true,
        expiresAt: true,
        organization: { select: { id: true, name: true, slug: true } },
        site: { select: { id: true, name: true, slug: true } }
      }
    }),
    db.invitation.count({ where: inviteWhere }),
    db.user.groupBy({
      by: ["role"],
      where: { deletedAt: null },
      _count: { _all: true }
    })
  ]);

  const bootstrapEmail = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase() ?? "";
  const rows = users.map((user: any) => {
    const isBootstrapAdmin = Boolean(bootstrapEmail && user.email.trim().toLowerCase() === bootstrapEmail);
    const isPlatformAdmin = user.role === "super_admin" || user.role === "admin" || Boolean(user.platformAdminGrant) || isBootstrapAdmin;
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      createdAt: user.createdAt,
      platformAccess: isPlatformAdmin,
      platformAccessSources: [
        ...(user.role === "super_admin" ? ["super admin"] : []),
        ...(user.role === "admin" ? ["global admin"] : []),
        ...(user.platformAdminGrant ? ["platform admin grant"] : []),
        ...(isBootstrapAdmin ? ["bootstrap admin"] : [])
      ],
      ownedClients: user.organizations.map((organization: any) => ({
        id: organization.id, name: organization.name, slug: organization.slug, appCount: organization._count.sites
      })),
      clientMemberships: user.collaborations.map((collaboration: any) => ({
        id: collaboration.organization.id, name: collaboration.organization.name, slug: collaboration.organization.slug,
        role: collaboration.role, appCount: collaboration.organization._count.sites
      })),
      appMemberships: user.siteCollaborations.map((membership: any) => ({
        id: membership.site.id, name: membership.site.name, slug: membership.site.slug,
        role: membership.role, clientName: membership.site.organization.name, clientSlug: membership.site.organization.slug
      })),
      accessListsTruncated:
        user.organizations.length === MAX_ACCESS_SCOPES_PER_USER ||
        user.collaborations.length === MAX_ACCESS_SCOPES_PER_USER ||
        user.siteCollaborations.length === MAX_ACCESS_SCOPES_PER_USER
    };
  });

  return {
    users: rows,
    page,
    pageSize,
    totalUsers,
    hasMoreUsers: page * pageSize < totalUsers,
    invitePage,
    invites,
    totalInvites,
    hasMoreInvites: invitePage * pageSize < totalInvites,
    counts: {
      super_admin: 0,
      admin: 0,
      collaborator: 0,
      ...Object.fromEntries(roleCounts.map((row: any) => [row.role, row._count._all]))
    }
  };
}
