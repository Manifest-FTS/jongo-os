import { evaluateCmsEntitlement, type CmsFeature, type CmsSponsorState } from "./entitlements";
import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/site-identity";

/** Scope and action bits only: never project subscription, identity or billing records. */
export type DatasetCmsCapabilities = {
  scope: "dataset";
  datasetId: string;
  organizationId: string | null;
  siteId: string | null;
  canRead: boolean;
  canExport: boolean;
  canEdit: boolean;
  canPublish: boolean;
  canManageDataset: boolean;
  canManageGrants: boolean;
  canCustomizeSchema: boolean;
};

type DatasetRole = "reader" | "editor" | "publisher" | "admin";
type Membership = { userId: string; role: string; deletedAt: Date | null };
type DatasetAccessRow = {
  id: string;
  organizationId: string;
  siteId: string | null;
  archivedAt: Date | null;
  organization: {
    id: string;
    ownerId: string;
    deletedAt: Date | null;
    owner: CmsSponsorState | null;
    collaborators: Array<Membership & { organizationId: string }>;
  } | null;
  site: {
    id: string;
    organizationId: string;
    deletedAt: Date | null;
    collaborators: Array<Membership & { siteId: string }>;
  } | null;
  grants: Array<{ datasetId: string; userId: string; role: string; revokedAt: Date | null }>;
};

const ranks: Record<DatasetRole, number> = { reader: 0, editor: 1, publisher: 2, admin: 3 };
function isDatasetRole(role: string): role is DatasetRole {
  return role === "reader" || role === "editor" || role === "publisher" || role === "admin";
}
function isLiveMember(member: Membership, userId: string): boolean {
  return member.userId === userId && member.deletedAt === null &&
    (member.role === "admin" || member.role === "collaborator");
}
function validId(value: unknown): value is string {
  return typeof value === "string" && isUuid(value);
}

/**
 * Server entry point. ONLY the authenticated route/session caller supplies userId;
 * neither argument proves access. No JWT roles, global/technical grants, bootstrap
 * emails, infrastructure repositories, mock data or cross-request caching are used.
 *
 * RepeatableRead keeps identity, memberships, grants and sponsor in one snapshot.
 * This is not a mutation guard/lock: callers must resolve again at the operation
 * boundary and bind subsequent queries to the returned dataset scope. A result
 * must never be persisted as authority for a later request.
 */
export async function resolveDatasetCmsCapabilities(
  userId: string,
  datasetId: string
): Promise<DatasetCmsCapabilities> {
  const denied: DatasetCmsCapabilities = {
    scope: "dataset", datasetId: typeof datasetId === "string" ? datasetId : "",
    organizationId: null, siteId: null,
    canRead: false, canExport: false, canEdit: false, canPublish: false,
    canManageDataset: false, canManageGrants: false, canCustomizeSchema: false
  };
  if (typeof window !== "undefined" || !validId(userId) || !validId(datasetId) ||
      process.env.JONGO_CMS_ENABLED !== "true") return denied;

  try {
    const db = await getDb();
    if (!db) return denied;
    // No legacy-schema fallback: an unavailable delegate/table/column disables ALL actions.
    return await db.$transaction(async (tx: {
      user: { findUnique: (query: unknown) => Promise<{ id: string; deletedAt: Date | null } | null> };
      cmsDataset: { findUnique: (query: unknown) => Promise<DatasetAccessRow | null> };
    }): Promise<DatasetCmsCapabilities> => {
      const actor = await tx.user.findUnique({
        where: { id: userId }, select: { id: true, deletedAt: true }
      });
      if (!actor || actor.id !== userId || actor.deletedAt !== null) return denied;
      const dataset = await tx.cmsDataset.findUnique({
        where: { id: datasetId },
        select: {
          id: true, organizationId: true, siteId: true, archivedAt: true,
          organization: { select: {
            id: true, ownerId: true, deletedAt: true,
            owner: { select: {
              id: true, deletedAt: true, subscriptionPlanId: true,
              subscriptionStatus: true, subscriptionCurrentPeriodEnd: true
            } },
            collaborators: {
              where: { userId, deletedAt: null },
              select: { organizationId: true, userId: true, role: true, deletedAt: true }
            }
          } },
          site: { select: {
            id: true, organizationId: true, deletedAt: true,
            collaborators: {
              where: { userId, deletedAt: null },
              select: { siteId: true, userId: true, role: true, deletedAt: true }
            }
          } },
          grants: {
            where: { userId, revokedAt: null },
            select: { datasetId: true, userId: true, role: true, revokedAt: true }
          }
        }
      });
      if (!dataset || dataset.id !== datasetId || dataset.archivedAt !== null ||
          !validId(dataset.organizationId)) return denied;
      const org = dataset.organization;
      if (!org || org.id !== dataset.organizationId || org.deletedAt !== null ||
          !validId(org.ownerId) || !org.owner || org.owner.id !== org.ownerId ||
          org.owner.deletedAt !== null) return denied;
      if (dataset.siteId !== null && (!validId(dataset.siteId) || !dataset.site ||
          dataset.site.id !== dataset.siteId || dataset.site.organizationId !== org.id ||
          dataset.site.deletedAt !== null)) return denied;

      const owner = org.ownerId === userId;
      const orgMembership = org.collaborators.find((member) =>
        member.organizationId === org.id && isLiveMember(member, userId));
      const siteMembership = dataset.siteId !== null && dataset.site?.collaborators.some((member) =>
        member.siteId === dataset.siteId && isLiveMember(member, userId));
      // A leftover dataset grant is NEVER an active tenant relationship.
      if (!owner && !orgMembership && !siteMembership) return denied;
      const grant = dataset.grants.find((entry) =>
        entry.datasetId === datasetId && entry.userId === userId && entry.revokedAt === null);
      if (grant && !isDatasetRole(grant.role)) return denied;
      if (!owner && !orgMembership && !grant) return denied;

      let role: DatasetRole = owner || orgMembership?.role === "admin" ? "admin" : "reader";
      if (grant && isDatasetRole(grant.role) && ranks[grant.role] > ranks[role]) role = grant.role;

      // Evaluate CAPACITY as the actual persisted owner, not as a synthetic actor
      // permission. Dataset role is intersected below; this does not promote actor.
      const now = new Date();
      const permits = (feature: CmsFeature) => evaluateCmsEntitlement({
        feature, organizationId: org.id, sponsor: org.owner,
        scope: { organizationId: org.id, ownerId: org.ownerId, userId: org.ownerId, role: "owner" },
        enabled: process.env.JONGO_CMS_ENABLED === "true", now
      });
      if (!permits("cms.read")) return denied;
      const author = permits("cms.author");
      const manage = author && role === "admin";
      return {
        scope: "dataset", datasetId, organizationId: org.id, siteId: dataset.siteId,
        canRead: true, canExport: true,
        canEdit: author && ranks[role] >= ranks.editor,
        canPublish: author && ranks[role] >= ranks.publisher,
        canManageDataset: manage, canManageGrants: manage,
        canCustomizeSchema: manage && permits("cms.schema.customize")
      };
    }, { isolationLevel: "RepeatableRead" });
  } catch {
    // Never return raw DB errors, partial permissions, stale data or sponsor details.
    return denied;
  }
}