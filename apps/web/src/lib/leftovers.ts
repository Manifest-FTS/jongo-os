/**
 * Leftovers: hosting resources whose Jongo app was deleted but which still run
 * on the server (deleted without "also delete in hosting", or hosting refused
 * the deletion and the app was archived anyway).
 *
 * They still appear in lists that read the hosting inventory, but their app
 * page is gone. Instead of a dead link, they are shown as "Deleted in Jongo,
 * still on the server" with two actions:
 *   - restore: bring the Jongo app back (nothing in hosting changes);
 *   - destroy: delete the resource from the server, after checking it still
 *     belongs to that client's hosting project.
 */

export type Leftover = { siteId: string; name: string; deletedAt: string; organizationId: string; resourceUuid: string };

type Db = any;

async function loadDb(): Promise<Db> {
  const { db } = await import("@/lib/db");
  return db;
}

/** Leftovers among these hosting resource ids, keyed by resource id. */
export async function findLeftovers(resourceUuids: string[], options: { db?: Db } = {}): Promise<Map<string, Leftover>> {
  const ids = [...new Set(resourceUuids.map((id) => id?.trim()).filter(Boolean))];
  const found = new Map<string, Leftover>();
  if (ids.length === 0) return found;
  const db = options.db ?? (await loadDb());
  const [deleted, live] = await Promise.all([
    db.site.findMany({
      where: { coolifyServiceUuid: { in: ids }, deletedAt: { not: null } },
      orderBy: { deletedAt: "desc" },
      select: { id: true, name: true, deletedAt: true, organizationId: true, coolifyServiceUuid: true }
    }),
    db.site.findMany({ where: { coolifyServiceUuid: { in: ids }, deletedAt: null }, select: { coolifyServiceUuid: true } })
  ]);
  // A resource a live app still uses is not a leftover, whatever was deleted before.
  const inUse = new Set(live.map((row: { coolifyServiceUuid: string }) => row.coolifyServiceUuid));
  for (const row of deleted) {
    const uuid = row.coolifyServiceUuid as string;
    if (inUse.has(uuid) || found.has(uuid)) continue; // newest deletion wins
    found.set(uuid, {
      siteId: row.id,
      name: row.name,
      deletedAt: new Date(row.deletedAt).toISOString(),
      organizationId: row.organizationId,
      resourceUuid: uuid
    });
  }
  return found;
}

export type LeftoverActionResult = { ok: true; message: string } | { ok: false; status: number; message: string };

/** The deleted app, if this user may act on it (an admin of its client). */
async function loadForAdmin(siteId: string, userId: string, db: Db) {
  if (!/^[0-9a-f-]{36}$/i.test(siteId)) return null;
  const site = await db.site.findFirst({
    where: { id: siteId, deletedAt: { not: null } },
    select: { id: true, name: true, organizationId: true, coolifyServiceUuid: true, coolifyProjectId: true }
  });
  if (!site?.coolifyServiceUuid) return null;
  const { resolveOrganizationAccess } = await import("@/lib/tenant-route-access");
  const access = await resolveOrganizationAccess(site.organizationId, userId);
  if (!access) return null;
  return { site, access };
}

export async function restoreLeftover(siteId: string, userId: string, options: { db?: Db } = {}): Promise<LeftoverActionResult> {
  const db = options.db ?? (await loadDb());
  const loaded = await loadForAdmin(siteId, userId, db);
  if (!loaded) return { ok: false, status: 404, message: "That app wasn't found." };
  if (!loaded.access.isAdmin) return { ok: false, status: 403, message: "Only the client's admins can restore apps." };
  const { site } = loaded;

  const taken = await db.site.findFirst({
    where: { coolifyServiceUuid: site.coolifyServiceUuid, deletedAt: null, id: { not: site.id } },
    select: { id: true }
  });
  if (taken) return { ok: false, status: 409, message: "Another app already uses this server resource, so this one can't be restored." };

  const restored = await db.site.updateMany({ where: { id: site.id, deletedAt: { not: null } }, data: { deletedAt: null } });
  if (restored.count !== 1) return { ok: false, status: 409, message: "It was restored or removed a moment ago. Refresh the page." };
  await audit(db, site.organizationId, userId, "site_restored_from_leftover", site.id, { resourceUuid: site.coolifyServiceUuid });
  return { ok: true, message: `${site.name} is back.` };
}

export async function destroyLeftover(
  siteId: string,
  userId: string,
  options: {
    db?: Db;
    overview?: () => Promise<{ mode: string; fetchError?: unknown; sites: Array<{ id: string; deployTargetId: string; coolifyProjectId?: string; siteType?: string }> }>;
    destroy?: (uuid: string, kind?: "application" | "service" | "database" | "unknown") => Promise<{ ok: boolean; message?: string }>;
  } = {}
): Promise<LeftoverActionResult> {
  const db = options.db ?? (await loadDb());
  const loaded = await loadForAdmin(siteId, userId, db);
  if (!loaded) return { ok: false, status: 404, message: "That app wasn't found." };
  if (!loaded.access.isAdmin) return { ok: false, status: 403, message: "Only the client's admins can delete apps from the server." };
  const { site, access } = loaded;
  const uuid = site.coolifyServiceUuid as string;

  // Never destroy something a live app uses.
  const inUse = await db.site.findFirst({ where: { coolifyServiceUuid: uuid, deletedAt: null }, select: { id: true } });
  if (inUse) return { ok: false, status: 409, message: "A live app uses this server resource, so it wasn't deleted." };

  const loadOverview = options.overview ?? (async () => (await import("@/lib/coolify")).getCoolifyOverview());
  const overview = await loadOverview();
  if (overview.mode !== "live" || overview.fetchError) {
    return { ok: false, status: 503, message: "Hosting isn't reachable right now, so nothing was deleted. Try again shortly." };
  }
  const resource = overview.sites.find((row) => row.deployTargetId === uuid || row.id === uuid);
  if (!resource) return { ok: true, message: "It's already gone from the server." };

  // The same rule as deleting a live app: the resource must sit in this
  // client's own hosting project. Platform admins may clean up anything.
  if (!access.isPlatformAdmin) {
    const projectIds = new Set<string>(
      [site.coolifyProjectId, access.organization.coolifyProjectId].filter((value): value is string => Boolean(value?.trim()))
    );
    const links: Array<{ coolifyProjectId: string }> = await db.$queryRaw`
      select "coolifyProjectId" from "OrganizationCoolifyProjectLink"
      where "organizationId" = ${site.organizationId}::uuid and "deletedAt" is null
    `;
    for (const link of links) projectIds.add(link.coolifyProjectId);
    if (!resource.coolifyProjectId || !projectIds.has(resource.coolifyProjectId)) {
      return { ok: false, status: 409, message: "This resource isn't in this client's hosting space, so it wasn't deleted. A platform admin can remove it." };
    }
  }

  const kind = resource.siteType === "database" ? "database" : resource.siteType === "wordpress" || resource.siteType === "service" ? "service" : "unknown";
  const destroy = options.destroy ?? (async (id: string, k?: "application" | "service" | "database" | "unknown") =>
    (await import("@/lib/coolify")).destroyCoolifyApplication(id, k));
  const result = await destroy(uuid, kind);
  await audit(db, site.organizationId, userId, result.ok ? "leftover_destroyed" : "leftover_destroy_failed", site.id, { resourceUuid: uuid, message: result.message ?? null });
  if (!result.ok) return { ok: false, status: 502, message: "Hosting didn't delete it. Try again in a minute." };
  return { ok: true, message: `${site.name} was deleted from the server.` };
}

async function audit(db: Db, organizationId: string, actorId: string, action: string, siteId: string, details: Record<string, unknown>) {
  try {
    await db.auditLog.create({ data: { organizationId, actorId, action, resourceType: "site", resourceId: siteId, details } });
  } catch (error) {
    console.error("[leftovers] audit failed", { action, siteId, error });
  }
}
