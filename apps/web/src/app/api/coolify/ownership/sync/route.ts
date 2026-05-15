import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getCoolifyOverview } from "@/lib/coolify";

function normalized(value?: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

/**
 * POST /api/coolify/ownership/sync
 *
 * Backfills ownership metadata from Coolify Projects into Jongo records.
 * - Updates Site.coolifyProjectId from Coolify resource ownership.
 * - Backfills Organization coolifyProjectId/coolifyProjectName when missing.
 * - Returns orphaned resources that still have no client mapping.
 */
export async function POST(request: Request) {
  const session = await auth();

  const syncToken = process.env.OWNERSHIP_SYNC_TOKEN;
  const authHeader = request.headers.get("authorization") ?? undefined;
  const providedToken = authHeader?.replace(/^Bearer\s+/i, "").trim();
  const tokenAuthorized = Boolean(syncToken && providedToken && providedToken === syncToken);

  if (!session?.user?.id && !tokenAuthorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { db } = await import("@/lib/db");

    const overview = await getCoolifyOverview();
    const organizations: any[] = await db.organization.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        slug: true,
        name: true,
        coolifyProjectId: true,
        coolifyProjectName: true
      }
    });

    const orgByProjectId = new Map<string, any>();
    const orgByProjectName = new Map<string, any>();

    for (const org of organizations) {
      if (org.coolifyProjectId) orgByProjectId.set(org.coolifyProjectId, org);
      const key = normalized(org.coolifyProjectName ?? org.name);
      if (key) orgByProjectName.set(key, org);
    }

    const dbSites: any[] = await db.site.findMany({
      where: { deletedAt: null },
      include: {
        organization: {
          select: {
            id: true,
            name: true,
            coolifyProjectId: true,
            coolifyProjectName: true
          }
        }
      }
    });

    let updatedSites = 0;
    let backfilledOrganizations = 0;

    for (const site of dbSites) {
      if (!site.coolifyServiceUuid) continue;

      const coolifySite = overview.sites.find(
        (item) => item.id === site.coolifyServiceUuid || item.deployTargetId === site.coolifyServiceUuid
      );

      if (!coolifySite?.coolifyProjectId) continue;

      if (site.coolifyProjectId !== coolifySite.coolifyProjectId) {
        await db.site.update({
          where: { id: site.id },
          data: {
            coolifyProjectId: coolifySite.coolifyProjectId,
            coolifyProjectName: coolifySite.coolifyProjectName ?? undefined
          }
        });
        updatedSites += 1;
      }

      if (!site.organization.coolifyProjectId) {
        await db.organization.update({
          where: { id: site.organizationId },
          data: {
            coolifyProjectId: coolifySite.coolifyProjectId,
            coolifyProjectName: coolifySite.coolifyProjectName ?? site.organization.coolifyProjectName ?? site.organization.name
          }
        });
        backfilledOrganizations += 1;
      }
    }

    const diagnostics = overview.sites.map((site) => {
      if (!site.coolifyProjectId && !site.coolifyProjectName) {
        return {
          resourceId: site.id,
          resourceName: site.name,
          coolifyProjectId: site.coolifyProjectId,
          coolifyProjectName: site.coolifyProjectName,
          status: "unavailable",
          message: "Coolify project unavailable from API"
        };
      }

      if (site.coolifyProjectId && orgByProjectId.has(site.coolifyProjectId)) {
        const org = orgByProjectId.get(site.coolifyProjectId);
        return {
          resourceId: site.id,
          resourceName: site.name,
          coolifyProjectId: site.coolifyProjectId,
          coolifyProjectName: site.coolifyProjectName,
          status: "mapped",
          message: `Mapped to Client: ${org.name}`
        };
      }

      const key = normalized(site.coolifyProjectName);
      if (key && orgByProjectName.has(key)) {
        const org = orgByProjectName.get(key);
        return {
          resourceId: site.id,
          resourceName: site.name,
          coolifyProjectId: site.coolifyProjectId,
          coolifyProjectName: site.coolifyProjectName,
          status: "mapped",
          message: `Mapped to Client: ${org.name}`
        };
      }

      return {
        resourceId: site.id,
        resourceName: site.name,
        coolifyProjectId: site.coolifyProjectId,
        coolifyProjectName: site.coolifyProjectName,
        status: "orphaned",
        message: "Project found but no Jongo Client mapped"
      };
    });

    const orphaned = diagnostics.filter((d) => d.status !== "mapped");

    return NextResponse.json({
      ok: true,
      updatedSites,
      backfilledOrganizations,
      orphanedCount: orphaned.length,
      orphaned,
      diagnostics
    });
  } catch (error) {
    console.error("POST /api/coolify/ownership/sync error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
