import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { isEffectiveViewer } from "@/lib/permissions";
import { resolvePrincipal } from "@/lib/rbac";
import { buildSiteIdentityWhere } from "@/lib/site-identity";

/**
 * View-only members ("viewer" role) may read but never change anything.
 *
 * Called first in every POST/PATCH/PUT/DELETE handler under /api/sites and
 * /api/organizations, with the handler's route context. It answers 403 only
 * when a signed-in user's every membership on that client or app is "viewer";
 * in every other case it returns null and the handler applies its own checks
 * as before. Machine callers (webhooks, ops tokens) have no session and pass
 * straight through to the handler's own authentication.
 */

export const READ_ONLY_MESSAGE = "You have view-only access here, so you can't make changes. Ask an admin if you need more access.";

type RouteContext = { params?: Promise<Record<string, string | string[] | undefined>> | Record<string, string | string[] | undefined> } | undefined;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

export async function isReadOnlyMember(input: { userId: string; siteId?: string; organizationId?: string }): Promise<boolean> {
  const principal = await resolvePrincipal(input.userId);
  if (!principal || principal.isPlatformAdmin) return false;
  const { getDb } = await import("@/lib/db");
  const db: any = await getDb();
  if (!db) return false;
  const userId = input.userId;

  if (input.siteId) {
    const site = await db.site.findFirst({
      where: { AND: [buildSiteIdentityWhere(input.siteId), { deletedAt: null }] },
      select: {
        organization: { select: { ownerId: true, collaborators: { where: { userId, deletedAt: null }, select: { role: true } } } },
        collaborators: { where: { userId, deletedAt: null }, select: { role: true } }
      }
    });
    if (!site) return false;
    if (site.organization?.ownerId === userId) return false;
    return isEffectiveViewer(site.organization?.collaborators?.[0]?.role, site.collaborators?.[0]?.role);
  }

  if (input.organizationId) {
    const organization = await db.organization.findFirst({
      // id is a uuid column: comparing it with a slug would throw.
      where: {
        ...(UUID.test(input.organizationId) ? { id: input.organizationId } : { slug: input.organizationId }),
        deletedAt: null
      },
      select: { ownerId: true, collaborators: { where: { userId, deletedAt: null }, select: { role: true } } }
    });
    if (!organization || organization.ownerId === userId) return false;
    return isEffectiveViewer(organization.collaborators?.[0]?.role, null);
  }

  return false;
}

/** 403 for a view-only member, otherwise null. Never throws. */
export async function readOnlyDenial(context: unknown): Promise<Response | null> {
  try {
    const raw = (context as RouteContext)?.params;
    const params = raw ? await raw : {};
    const siteId = first(params.siteId);
    const organizationId = first(params.organizationId) || first(params.clientId);
    if (!siteId && !organizationId) return null;

    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return null;

    const readOnly = await isReadOnlyMember({ userId, siteId: siteId || undefined, organizationId: siteId ? undefined : organizationId });
    return readOnly
      ? NextResponse.json({ ok: false, error: READ_ONLY_MESSAGE, message: READ_ONLY_MESSAGE, reason: "read_only" }, { status: 403 })
      : null;
  } catch (error) {
    // Fail open to the handler, which still runs its own access checks; a
    // guard outage must not take every write route down.
    console.error("[read-only-guard] check failed", error);
    return null;
  }
}
