import { getDb } from "@/lib/db";
import { resolvePrincipal } from "@/lib/rbac";
import { isUuid } from "@/lib/site-identity";

/** Shell identity only. A site relationship is NEVER a client/dataset grant. */
export async function resolveClientLayoutAccess(clientId: string, userId?: string) {
  if (!clientId?.trim() || !userId?.trim()) return null;
  try {
    const principal = await resolvePrincipal(userId);
    if (!principal) return null;
    const db = await getDb();
    if (!db) return null;
    const identity = isUuid(clientId)
      ? { OR: [{ id: clientId }, { slug: clientId }] }
      : { slug: clientId };
    const select = { id: true, name: true } as const;
    const organization = await db.organization.findFirst({
      where: {
        deletedAt: null, ...identity,
        ...(!principal.isPlatformAdmin ? { AND: [{ OR: [
          { ownerId: userId },
          { collaborators: { some: { userId, deletedAt: null } } }
        ] }] } : {})
      },
      select
    });
    if (organization) return { scope: "organization" as const, client: organization };

    const client = await db.organization.findFirst({
      where: {
        deletedAt: null, ...identity,
        sites: { some: {
          deletedAt: null,
          collaborators: { some: { userId, deletedAt: null } }
        } }
      },
      select
    });
    return client ? { scope: "site" as const, client } : null;
  } catch {
    // No demo, session-role, header/pathname or legacy-schema fallback.
    return null;
  }
}