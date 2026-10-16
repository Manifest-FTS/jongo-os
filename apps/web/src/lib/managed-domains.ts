import { BillingInputError, assertKeys, clientBillingDto, CLIENT_BILLING_SELECT, objectBody, pagination, validId } from "./client-billing";
import type { BillingClient } from "./client-billing-drivers";

export const MANAGED_DOMAIN_TECHNICAL_SELECT = {
  id: true, name: true, organizationId: true, status: true, registrar: true,
  expiresAt: true, autoRenew: true, dnsStatus: true, nameservers: true,
  cloudflareZoneId: true, registrarSyncedAt: true
} as const;

export type ManagedDomainRow = {
  id: string; name: string; organizationId: string | null; status: string; registrar: string;
  expiresAt: Date | null; autoRenew: boolean; dnsStatus: string | null; nameservers: string[];
  cloudflareZoneId: string | null; registrarSyncedAt: Date | null;
  organization: { id: string; name: string } | BillingClient | null;
  isBillable?: boolean; billingOverride?: boolean;
};

export function managedDomainSelect(superAdmin: boolean) {
  return {
    ...MANAGED_DOMAIN_TECHNICAL_SELECT,
    organization: { select: superAdmin ? CLIENT_BILLING_SELECT : { id: true, name: true } },
    ...(superAdmin ? { isBillable: true, billingOverride: true } : {})
  };
}

export async function managedDomainDto(row: ManagedDomainRow, superAdmin: boolean) {
  const technical = {
    id: row.id, name: row.name, organizationId: row.organizationId,
    client: row.organization ? { id: row.organization.id, name: row.organization.name } : null,
    status: row.status, registrar: row.registrar, expiresAt: row.expiresAt,
    autoRenew: row.autoRenew, dnsStatus: row.dnsStatus, nameservers: row.nameservers,
    cloudflareZoneId: row.cloudflareZoneId, registrarSyncedAt: row.registrarSyncedAt
  };
  if (!superAdmin) return technical;
  return { ...technical, financial: {
    isBillable: row.isBillable, billingOverride: row.billingOverride,
    clientBilling: row.organization ? await clientBillingDto(row.organization as BillingClient) : null
  } };
}

export function managedDomainQuery(params: URLSearchParams, superAdmin: boolean, visibleIds: string[] | null) {
  const paging = pagination(params);
  const assignment = params.get("assignment") ?? "all";
  if (!["all", "assigned", "unassigned"].includes(assignment)) throw new BillingInputError("Invalid assignment filter.");
  if (assignment === "unassigned" && !superAdmin) throw new BillingInputError("Forbidden", 403);
  const clientId = params.get("clientId");
  if (clientId !== null && !validId(clientId)) throw new BillingInputError("Invalid client ID.");
  if (clientId && assignment === "unassigned") throw new BillingInputError("Client and unassigned filters cannot be combined.");
  const q = params.get("q") ?? "";
  if (q.length > 253) throw new BillingInputError("Search is too long.");
  // Never put null in a collaborator's scope, even if no memberships exist.
  const where = {
    deletedAt: null,
    ...(visibleIds !== null ? { organizationId: { in: clientId ? visibleIds.filter((id) => id === clientId) : visibleIds } }
      : assignment === "unassigned" ? { organizationId: null }
      : clientId ? { organizationId: clientId }
      : assignment === "assigned" ? { organizationId: { not: null } } : {}),
    ...(q ? { name: { contains: q, mode: "insensitive" } } : {})
  };
  return { ...paging, where };
}

export type ManagedDomainUpdate = { organizationId?: string | null; isBillable?: boolean; billingOverride?: boolean };
export function validateManagedDomainUpdate(value: unknown): { domainId: string; data: ManagedDomainUpdate } {
  const body = objectBody(value);
  assertKeys(body, ["domainId", "organizationId", "isBillable", "billingOverride"]);
  if (!validId(body.domainId)) throw new BillingInputError("Invalid domain ID.");
  const data: ManagedDomainUpdate = {};
  if ("organizationId" in body) {
    if (body.organizationId !== null && !validId(body.organizationId)) throw new BillingInputError("Choose a valid client ID or null.");
    data.organizationId = body.organizationId;
  }
  for (const key of ["isBillable", "billingOverride"] as const) {
    if (key in body) {
      if (typeof body[key] !== "boolean") throw new BillingInputError(`${key} must be a boolean.`);
      data[key] = body[key];
    }
  }
  if (!Object.keys(data).length) throw new BillingInputError("No update fields supplied.");
  return { domainId: body.domainId, data };
}