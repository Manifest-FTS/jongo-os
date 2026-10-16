import { getDb } from "@/lib/db";
import { canViewBilling } from "@/lib/rbac";
import { getVisibleOrganizationIds } from "@/lib/domain-orders";
import { BillingInputError } from "@/lib/client-billing";
import { billingError, billingJson, billingViewer, readBillingBody } from "@/lib/client-billing-http";
import { managedDomainDto, managedDomainQuery, managedDomainSelect, validateManagedDomainUpdate, type ManagedDomainRow } from "@/lib/managed-domains";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const viewer = await billingViewer(false);
    const superAdmin = canViewBilling(viewer);
    const params = new URL(request.url).searchParams;
    // Reject a forbidden unmapped screen before any inventory/scoping query.
    managedDomainQuery(params, superAdmin, []);
    const visibleIds = await getVisibleOrganizationIds(viewer.userId, viewer.isPlatformAdmin);
    if (!viewer.isPlatformAdmin && visibleIds === null) throw new BillingInputError("Forbidden", 403);
    const { where, page, pageSize, skip, take } = managedDomainQuery(params, superAdmin, visibleIds);
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const rows: ManagedDomainRow[] = await db.domain.findMany({
      where, select: managedDomainSelect(superAdmin), orderBy: [{ name: "asc" }, { id: "asc" }], skip, take: take + 1
    });
    return billingJson({ domains: await Promise.all(rows.slice(0, take).map((row) => managedDomainDto(row, superAdmin))), page, pageSize, hasMore: rows.length > take, canManageBilling: superAdmin });
  } catch (error) { return billingError(error); }
}

export async function PATCH(request: Request) {
  try {
    const viewer = await billingViewer();
    const { domainId, data } = validateManagedDomainUpdate(await readBillingBody(request));
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    await db.$transaction(async (tx: NonNullable<typeof db>) => {
      const current = await tx.domain.findFirst({ where: { id: domainId, deletedAt: null }, select: { id: true, organizationId: true } });
      if (!current) throw new BillingInputError("Domain not found.", 404);
      const targetId = data.organizationId === undefined ? current.organizationId : data.organizationId;
      if (targetId) {
        const target = await tx.organization.findFirst({ where: { id: targetId, deletedAt: null }, select: { id: true } });
        if (!target) throw new BillingInputError("Choose an active client.");
      }
      if (!targetId && (data.isBillable !== undefined || data.billingOverride !== undefined)) throw new BillingInputError("Map the domain to an active client before changing billing flags.", 409);
      const auditClients = [...new Set<string>([current.organizationId, targetId].filter((id): id is string => typeof id === "string"))];
      if (!auditClients.length) throw new BillingInputError("Map this unassigned domain to an active client first.", 409);
      await tx.domain.update({ where: { id: domainId }, data, select: { id: true } });
      for (const organizationId of auditClients) {
        await tx.auditLog.create({ data: {
          organizationId, actorId: viewer.userId, action: "managed_domain_updated", resourceType: "domain", resourceId: domainId,
          details: { fields: Object.keys(data), previousOrganizationId: current.organizationId, organizationId: targetId }
        } });
      }
    }, { isolationLevel: "Serializable" });
    return billingJson({ updated: true, domainId });
  } catch (error) { return billingError(error); }
}