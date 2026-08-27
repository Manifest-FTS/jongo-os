/**
 * Automatic sync between Coolify's project list and Jongo's Organization
 * (client) records, run from the hourly reconcile loop alongside the
 * existing per-app self-healing (see platform-reconcile.ts).
 *
 * Two directions, both soft/reversible:
 *   1. A Coolify project with no linked Organization gets one created
 *      automatically, owned by the platform's bootstrap admin.
 *   2. An Organization whose linked Coolify project can no longer be found
 *      gets soft-deleted, mirroring Site.resourceMissingSince: missing is
 *      recorded first, and only acted on after it stays missing past a grace
 *      period, so a transient Coolify API failure cannot delete a client.
 *      A batch-level circuit breaker (shared with the existing site archiver)
 *      refuses to act at all if an implausible share of clients look deleted
 *      at once -- far more likely an API problem than reality.
 */

import { getDb } from "@/lib/db";
import { listCoolifyProjects } from "@/lib/coolify";
import { decideSiteArchive, shouldAbortArchiveBatch } from "./platform-reconcile-match";

export function autoSyncCoolifyProjectsDefaultEnabled(
  raw: string | undefined = process.env.JONGO_AUTO_SYNC_COOLIFY_PROJECTS
): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  return !(value === "false" || value === "0" || value === "off" || value === "no");
}

export type OrganizationSyncSummary = {
  ran: boolean;
  reason?: string;
  created: number;
  missingSinceSet: number;
  missingSinceCleared: number;
  archived: number;
  archiveAborted: boolean;
  archiveAbortReason?: string;
};

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function uniqueSlug(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, base: string): Promise<string> {
  const root = base || `client-${Math.random().toString(36).slice(2, 8)}`;
  let candidate = root;
  let attempt = 1;
  while (await db.organization.findUnique({ where: { slug: candidate }, select: { id: true } })) {
    attempt += 1;
    candidate = `${root}-${attempt}`.slice(0, 60);
  }
  return candidate;
}

export async function syncCoolifyProjectsToOrganizations(input?: {
  graceDays?: number;
  now?: Date;
}): Promise<OrganizationSyncSummary> {
  const empty: OrganizationSyncSummary = {
    ran: false,
    created: 0,
    missingSinceSet: 0,
    missingSinceCleared: 0,
    archived: 0,
    archiveAborted: false
  };

  if (!autoSyncCoolifyProjectsDefaultEnabled()) {
    return { ...empty, reason: "disabled" };
  }

  const db = await getDb();
  if (!db) {
    return { ...empty, reason: "database_unavailable" };
  }

  let liveProjects;
  try {
    liveProjects = await listCoolifyProjects();
  } catch (error) {
    console.error("[jongo] syncCoolifyProjectsToOrganizations: Coolify project list fetch failed:", error);
    return { ...empty, reason: "coolify_unreachable" };
  }

  const liveIds = new Set(liveProjects.map((p) => p.id));
  const now = input?.now ?? new Date();
  const graceDays = input?.graceDays ?? 7;

  const orgs = await db.organization.findMany({
    where: { deletedAt: null, coolifyProjectId: { not: null } },
    select: { id: true, coolifyProjectId: true, resourceMissingSince: true }
  });
  const linkedProjectIds = new Set(orgs.map((o: any) => o.coolifyProjectId).filter(Boolean));

  // ── 1. Auto-create a client for every live project with no Organization ──
  let created = 0;
  const seedEmail = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim();
  const owner = seedEmail
    ? await db.user.findFirst({ where: { email: { equals: seedEmail, mode: "insensitive" } }, select: { id: true } })
    : null;

  if (owner) {
    for (const project of liveProjects) {
      if (linkedProjectIds.has(project.id)) continue;

      const slug = await uniqueSlug(db, slugify(project.name));
      try {
        const org = await db.organization.create({
          data: {
            slug,
            name: project.name,
            ownerId: owner.id,
            coolifyProjectId: project.id,
            coolifyProjectName: project.name,
            collaborators: { create: { userId: owner.id, role: "admin" } }
          },
          select: { id: true }
        });
        await db.organizationCoolifyProjectLink.create({
          data: { organizationId: org.id, coolifyProjectId: project.id, coolifyProjectName: project.name, isPrimary: true }
        });
        created += 1;
      } catch (error) {
        console.error(`[jongo] syncCoolifyProjectsToOrganizations: failed to create client for project ${project.id}:`, error);
      }
    }
  }

  // ── 2. Archive (soft delete) a client whose Coolify project is gone ──
  const stillMissing = orgs.filter((o: any) => !liveIds.has(o.coolifyProjectId));
  const reappeared = orgs.filter((o: any) => liveIds.has(o.coolifyProjectId) && o.resourceMissingSince);

  let missingSinceCleared = 0;
  for (const org of reappeared) {
    await db.organization.update({ where: { id: org.id }, data: { resourceMissingSince: null } });
    missingSinceCleared += 1;
  }

  let missingSinceSet = 0;
  const archiveCandidates: string[] = [];
  for (const org of stillMissing) {
    if (!org.resourceMissingSince) {
      await db.organization.update({ where: { id: org.id }, data: { resourceMissingSince: now } });
      missingSinceSet += 1;
      continue;
    }
    const decision = decideSiteArchive({ missingSince: org.resourceMissingSince, now, graceDays, indexComplete: true });
    if (decision.archive) {
      archiveCandidates.push(org.id);
    }
  }

  const abortCheck = shouldAbortArchiveBatch({ candidates: archiveCandidates.length, totalSites: orgs.length });
  let archived = 0;
  if (!abortCheck.abort) {
    for (const orgId of archiveCandidates) {
      await db.$transaction([
        db.organization.update({ where: { id: orgId }, data: { deletedAt: now } }),
        db.site.updateMany({ where: { organizationId: orgId, deletedAt: null }, data: { deletedAt: now } })
      ]);
      archived += 1;
    }
  }

  return {
    ran: true,
    created,
    missingSinceSet,
    missingSinceCleared,
    archived,
    archiveAborted: abortCheck.abort,
    archiveAbortReason: abortCheck.abort ? abortCheck.reason : undefined
  };
}
