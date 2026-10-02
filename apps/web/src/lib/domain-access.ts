import { auth } from "@/lib/auth.config";
import { getDb } from "@/lib/db";
import { isPlatformAdminEmail } from "@/lib/permissions";
import { canManageOrganization, getVisibleOrganizationIds } from "@/lib/domain-orders";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type DomainViewer = { userId: string; email: string; isPlatformAdmin: boolean };

export async function getDomainViewer(): Promise<DomainViewer | null> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;
  const email = session.user?.email ?? "";
  return { userId, email, isPlatformAdmin: await isPlatformAdminEmail(email) };
}

/**
 * A domain the viewer may see, and whether they may change it (DNS, renew).
 * Seeing follows client membership; changing needs a client admin, because a
 * wrong DNS record takes the client's site or email down.
 */
export async function loadDomainForViewer(domainId: string, viewer: DomainViewer): Promise<{ domain: any; canManage: boolean } | null> {
  const db: any = await getDb();
  if (!db || !/^[0-9a-f-]{36}$/i.test(domainId)) return null;
  const domain = await db.domain.findFirst({ where: { id: domainId, deletedAt: null } });
  if (!domain) return null;
  const visible = await getVisibleOrganizationIds(viewer.userId, viewer.isPlatformAdmin);
  if (visible && !visible.includes(domain.organizationId)) return null;
  return { domain, canManage: await canManageOrganization(domain.organizationId, viewer.userId, viewer.isPlatformAdmin) };
}
