import { db } from "@/lib/db";
import { resolvePrincipal } from "@/lib/rbac";
import { isAdminRole } from "@/lib/roles";
import { buildSiteIdentityWhere } from "@/lib/site-identity";

/** Technical access only. Site grants must never become organization grants. */
export async function resolveOrganizationAccess(organizationId: string, userId: string) {
  const principal = await resolvePrincipal(userId);
  if (!principal) return null;
  const organization = await db.organization.findFirst({
    where: {
      id: organizationId, deletedAt: null,
      ...(!principal.isPlatformAdmin ? { OR: [
        { ownerId: userId }, { collaborators: { some: { userId, deletedAt: null } } }
      ] } : {})
    },
    select: {
      id: true, ownerId: true, name: true, slug: true, description: true,
      coolifyProjectId: true, coolifyProjectName: true,
      collaborators: { where: { userId, deletedAt: null }, select: { role: true } }
    }
  });
  if (!organization) return null;
  return {
    organization, isPlatformAdmin: principal.isPlatformAdmin,
    isAdmin: principal.isPlatformAdmin || organization.ownerId === userId || isAdminRole(organization.collaborators[0]?.role)
  };
}

export async function resolveSiteAccess(siteId: string, userId: string) {
  const principal = await resolvePrincipal(userId);
  if (!principal) return null;
  const site = await db.site.findFirst({
    where: { AND: [
      buildSiteIdentityWhere(siteId),
      { organization: { deletedAt: null } },
      ...(!principal.isPlatformAdmin ? [{ OR: [
        { organization: { OR: [
          { ownerId: userId }, { collaborators: { some: { userId, deletedAt: null } } }
        ] } },
        { collaborators: { some: { userId, deletedAt: null } } }
      ] }] : [])
    ] },
    select: {
      id: true, name: true, organizationId: true, coolifyServiceUuid: true, coolifyProjectId: true,
      organization: { select: {
        id: true, ownerId: true, coolifyProjectId: true,
        collaborators: { where: { userId, deletedAt: null }, select: { role: true } }
      } },
      collaborators: { where: { userId, deletedAt: null }, select: { role: true } }
    }
  });
  if (!site) return null;
  return {
    site, isPlatformAdmin: principal.isPlatformAdmin,
    isAdmin: principal.isPlatformAdmin || site.organization.ownerId === userId ||
      isAdminRole(site.organization.collaborators[0]?.role) || isAdminRole(site.collaborators[0]?.role)
  };
}

/** Check the submitted value, not normalizeRole's permissive legacy fallback. */
export function isTenantMutationRole(value: unknown): value is "admin" | "collaborator" {
  return value === "admin" || value === "collaborator";
}

export function hasOnlyFields(body: unknown, fields: readonly string[]): body is Record<string, unknown> {
  return Boolean(body && typeof body === "object" && !Array.isArray(body) &&
    Object.keys(body).every((key) => fields.includes(key)));
}