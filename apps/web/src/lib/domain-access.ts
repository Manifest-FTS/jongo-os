import { auth } from "@/lib/auth.config";
import { getDb } from "@/lib/db";
import { canViewBilling, resolvePrincipal } from "@/lib/rbac";
import { canManageOrganization, getVisibleOrganizationIds } from "@/lib/domain-orders";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type DomainViewer = { userId: string; email: string; isPlatformAdmin: boolean; isSuperAdmin: boolean };

/** Allowlist: new billing fields must never ride along in technical DTOs. */
export const DOMAIN_TECHNICAL_SELECT = {
  id: true, organizationId: true, name: true, status: true, registrar: true,
  cloudflareZoneId: true, nameservers: true, dnsStatus: true, expiresAt: true
} as const;

/** Only read after a fresh financial authorization. No contacts or EPP secrets. */
export const DOMAIN_CHARGE_FINANCIAL_SELECT = {
  id: true, operation: true, years: true, status: true, currency: true,
  wholesaleCents: true, markupPercent: true, markupCents: true, clientCents: true,
  registrarChargedCents: true, createdAt: true, updatedAt: true, error: true,
  stripePaymentIntentId: true, stripeRefundId: true
} as const;

export async function getDomainViewer(): Promise<DomainViewer | null> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;
  const principal = await resolvePrincipal(userId);
  if (!principal) return null;
  return { userId: principal.userId, email: principal.email, isPlatformAdmin: principal.isPlatformAdmin, isSuperAdmin: canViewBilling(principal) };
}

/**
 * A domain the viewer may see, and whether they may change it (DNS, renew).
 * Seeing follows client membership; changing needs a client admin, because a
 * wrong DNS record takes the client's site or email down.
 */
export async function loadDomainForViewer(domainId: string, viewer: DomainViewer): Promise<{ domain: any; canManage: boolean } | null> {
  const db: any = await getDb();
  if (!db || !/^[0-9a-f-]{36}$/i.test(domainId)) return null;
  const domain = await db.domain.findFirst({
    where: { id: domainId, deletedAt: null },
    select: { ...DOMAIN_TECHNICAL_SELECT, ...(viewer.isSuperAdmin ? { lastError: true } : {}) }
  });
  if (!domain) return null;
  const visible = await getVisibleOrganizationIds(viewer.userId, viewer.isPlatformAdmin);
  if (visible && !visible.includes(domain.organizationId)) return null;
  return { domain, canManage: await canManageOrganization(domain.organizationId, viewer.userId, viewer.isPlatformAdmin) };
}
