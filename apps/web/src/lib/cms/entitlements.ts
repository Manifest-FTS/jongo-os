import type { TierPlan } from "@/lib/public-plans";

export type CmsFeature = "cms.read" | "cms.author" | "cms.schema.customize";

/** Internal policy inputs, resolved by the server, NEVER accepted from a request/JWT. */
export type CmsOrganizationScope = {
  organizationId: string;
  userId: string;
  ownerId: string;
  role: "owner" | "admin" | "collaborator";
};

/** Persisted Organization.owner subscription, not the acting collaborator's plan. */
export type CmsSponsorState = {
  id: string;
  deletedAt: Date | null;
  subscriptionPlanId: string | null;
  subscriptionStatus: string | null;
  subscriptionCurrentPeriodEnd: Date | null;
};

export type CmsPolicyInput = {
  feature: CmsFeature;
  organizationId: string;
  scope: CmsOrganizationScope | null;
  sponsor: CmsSponsorState | null;
  enabled: boolean;
  now: Date;
};

// Reviewed persisted IDs only. Studio/Scale are display names, NOT new billing IDs.
const AUTHOR_PLAN_IDS: readonly TierPlan["id"][] = ["core-sla", "enterprise-sla"];

/**
 * Pure ORGANIZATION capacity policy, not a dataset/content authorization guard.
 * Read includes retaining/exporting existing tenant content after cancellation.
 * Owner is the only draft-editing tenant admin for now; all collaborators,
 * including org admins, remain read-only until explicit dataset grants exist.
 * No global role, bootstrap identity, technical grant or actor plan is an input.
 */
export function evaluateCmsEntitlement(input: CmsPolicyInput): boolean {
  const { feature, organizationId, scope, sponsor, enabled, now } = input;
  if (enabled !== true || !organizationId?.trim() || !scope || !sponsor) return false;
  if (!scope.userId?.trim() || !scope.ownerId?.trim() || scope.organizationId !== organizationId ||
      sponsor.id !== scope.ownerId || sponsor.deletedAt !== null) return false;
  if (!["owner", "admin", "collaborator"].includes(scope.role)) return false;
  // Reject a spoofed ownership role even for reads.
  if (scope.role === "owner" && scope.userId !== scope.ownerId) return false;
  if (feature === "cms.read") return true;
  if (feature !== "cms.author" && feature !== "cms.schema.customize") return false;
  if (scope.role !== "owner" || scope.userId !== scope.ownerId) return false;
  if (sponsor.subscriptionStatus !== "active" ||
      !(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      !(sponsor.subscriptionCurrentPeriodEnd instanceof Date) ||
      !Number.isFinite(sponsor.subscriptionCurrentPeriodEnd.getTime()) ||
      sponsor.subscriptionCurrentPeriodEnd.getTime() <= now.getTime()) return false;
  if (feature === "cms.schema.customize") return sponsor.subscriptionPlanId === "enterprise-sla";
  return AUTHOR_PLAN_IDS.some((id) => id === sponsor.subscriptionPlanId);
}

/** Safe to project to a client; contains no subscription/financial/provider data. */
export type OrganizationCmsCapabilities = {
  scope: "organization";
  organizationId: string;
  requiresBoundDataset: true;
  mutationsEnabled: false;
  features: Record<CmsFeature, boolean>;
};

/**
 * Server-only entry point. userId must come from the authenticated server session;
 * organizationId is only a lookup target, never proof of access. Every call reads
 * a fresh principal, org, owner subscription and live organization membership.
 * Deliberately does not reuse infrastructure access/repositories (global grants
 * and mock fallbacks there do not confer content authority).
 *
 * SCAFFOLD ONLY: no CmsDataset exists yet. Even true org capacity is insufficient
 * for content access: future handlers MUST resolve a live dataset bound to this
 * org plus explicit dataset permissions and recheck at the operation boundary.
 * This module enables no CMS mutation, publish, preview or delivery endpoint.
 */
export async function resolveOrganizationCmsCapabilities(
  userId: string,
  organizationId: string
): Promise<OrganizationCmsCapabilities> {
  const denied: OrganizationCmsCapabilities = {
    scope: "organization", organizationId, requiresBoundDataset: true, mutationsEnabled: false,
    features: { "cms.read": false, "cms.author": false, "cms.schema.customize": false }
  };
  // Do not import DB/auth into the pure policy path or execute this resolver in a browser.
  if (typeof window !== "undefined" || !userId?.trim() || !organizationId?.trim() ||
      process.env.JONGO_CMS_ENABLED !== "true") return denied;
  try {
    const { getDb } = await import("@/lib/db");
    const { resolvePrincipal } = await import("@/lib/rbac");
    const principal = await resolvePrincipal(userId);
    if (!principal || principal.userId !== userId) return denied;
    const db = await getDb();
    if (!db) return denied;
    const organization = await db.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, ownerId: true, deletedAt: true }
    });
    if (!organization || organization.id !== organizationId || organization.deletedAt !== null ||
        !organization.ownerId) return denied;

    let role: CmsOrganizationScope["role"];
    if (organization.ownerId === principal.userId) {
      role = "owner";
    } else {
      const membership = await db.collaborator.findFirst({
        where: { organizationId, userId: principal.userId, deletedAt: null },
        select: { organizationId: true, userId: true, role: true, deletedAt: true }
      });
      if (!membership || membership.organizationId !== organizationId || membership.userId !== userId ||
          membership.deletedAt !== null ||
          (membership.role !== "admin" && membership.role !== "collaborator")) return denied;
      role = membership.role;
    }

    const sponsor: CmsSponsorState | null = await db.user.findUnique({
      where: { id: organization.ownerId },
      select: {
        id: true, deletedAt: true, subscriptionPlanId: true,
        subscriptionStatus: true, subscriptionCurrentPeriodEnd: true
      }
    });
    const scope: CmsOrganizationScope = {
      organizationId, userId: principal.userId, ownerId: organization.ownerId, role
    };
    const now = new Date();
    const permits = (feature: CmsFeature) => evaluateCmsEntitlement({
      feature, organizationId, scope, sponsor, now, enabled: process.env.JONGO_CMS_ENABLED === "true"
    });
    return { ...denied, features: {
      "cms.read": permits("cms.read"), "cms.author": permits("cms.author"),
      "cms.schema.customize": permits("cms.schema.customize")
    } };
  } catch {
    // DB outage/schema mismatch must not expose mock data, stale grants or financial errors.
    return denied;
  }
}