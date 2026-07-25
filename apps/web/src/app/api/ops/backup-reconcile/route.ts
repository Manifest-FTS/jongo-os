import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { ensureCoolifyAppBackupSchedules } from "@/lib/coolify";
import { buildLiveResourceIndex, reconcileSite } from "@/lib/platform-reconcile";

function normalizeEmail(value?: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

function isAuthorized(session: Awaited<ReturnType<typeof auth>>, request: Request): boolean {
  const reconcileToken = process.env.BACKUP_RECONCILE_TOKEN?.trim() || process.env.OWNERSHIP_SYNC_TOKEN?.trim();
  const authHeader = request.headers.get("authorization") ?? "";
  const providedToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  const tokenAuthorized = Boolean(reconcileToken && providedToken && providedToken === reconcileToken);

  const bootstrapAdmin = normalizeEmail(process.env.BOOTSTRAP_ADMIN_EMAIL);
  const sessionEmail = normalizeEmail(session?.user?.email);
  const adminSession = Boolean(session?.user?.id && bootstrapAdmin && sessionEmail === bootstrapAdmin);

  return tokenAuthorized || adminSession;
}

function parseLimit(request: Request): number {
  const url = new URL(request.url);
  const raw = Number(url.searchParams.get("limit") || 0);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 100;
  }

  return Math.min(Math.floor(raw), 500);
}

export async function POST(request: Request) {
  const session = await auth();
  if (!isAuthorized(session, request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { db } = await import("@/lib/db");
    const limit = parseLimit(request);
    const sites = await db.site.findMany({
      where: {
        deletedAt: null,
        NOT: [{ coolifyServiceUuid: null }]
      },
      select: {
        id: true,
        slug: true,
        name: true,
        coolifyServiceUuid: true,
        coolifyProjectId: true,
        stagingEnabled: true
      },
      orderBy: { updatedAt: "desc" },
      take: limit
    });

    // Platform self-healing runs for EVERY site each pass, so apps created
    // later are reconciled automatically with no manual step. The live resource
    // index is fetched once per run rather than per site.
    const liveIndex = await buildLiveResourceIndex();
    let mappingsRepaired = 0;
    let mappingsStaleUnresolved = 0;
    let stagingEnvsEnsured = 0;
    let stagingResourcesFlagged = 0;
    let resourcesMissing = 0;

    let alreadyConfigured = 0;
    let autoProvisioned = 0;
    let failed = 0;
    const results: Array<{
      siteId: string;
      slug: string;
      appUuid: string;
      configuredAfter: boolean;
      note?: string;
    }> = [];

    for (const site of sites) {
      let appUuid = site.coolifyServiceUuid?.trim();
      if (!appUuid) {
        continue;
      }

      // Self-heal before reconciling backups: a repaired mapping changes which
      // Coolify resource the backup schedules should be checked against.
      try {
        const healed = await reconcileSite(
          {
            id: site.id,
            name: site.name,
            coolifyServiceUuid: site.coolifyServiceUuid,
            coolifyProjectId: site.coolifyProjectId,
            stagingEnabled: site.stagingEnabled
          },
          liveIndex,
          async (siteId, uuid) => {
            // Raw UPDATE: resilient to schema drift, and touches only this column.
            await db.$executeRaw`UPDATE "Site" SET "coolifyServiceUuid" = ${uuid}, "updatedAt" = now() WHERE id = ${siteId}::uuid`;
          }
        );
        if (healed.mappingRepaired) {
          mappingsRepaired += 1;
          appUuid = healed.mappingRepaired.to;
        }
        if (healed.notes.includes("mapping_stale_unresolved")) {
          mappingsStaleUnresolved += 1;
        }
        if (healed.stagingEnvironmentEnsured) {
          stagingEnvsEnsured += 1;
        }

        // Persist classification so the UI and backup eligibility read a cheap
        // flag. Raw UPDATE: touches only these columns, resilient to drift.
        if (healed.isStagingResource !== undefined) {
          if (healed.isStagingResource) stagingResourcesFlagged += 1;
          await db.$executeRaw`UPDATE "Site" SET "isStagingResource" = ${healed.isStagingResource} WHERE id = ${site.id}::uuid`;
        }
        if (healed.resourceMissing !== undefined) {
          if (healed.resourceMissing) {
            resourcesMissing += 1;
            await db.$executeRaw`UPDATE "Site" SET "resourceMissingSince" = COALESCE("resourceMissingSince", now()) WHERE id = ${site.id}::uuid`;
          } else {
            await db.$executeRaw`UPDATE "Site" SET "resourceMissingSince" = NULL WHERE id = ${site.id}::uuid`;
          }
        }
      } catch {
        // Healing is best-effort; never block backup reconciliation.
      }

      try {
        const reconciliation = await ensureCoolifyAppBackupSchedules(appUuid);
        if (reconciliation.note === "already_configured") {
          alreadyConfigured += 1;
        } else if (reconciliation.configuredAfter) {
          autoProvisioned += 1;
        } else {
          failed += 1;
        }

        results.push({
          siteId: site.id,
          slug: site.slug,
          appUuid,
          configuredAfter: reconciliation.configuredAfter,
          note: reconciliation.note
        });
      } catch {
        failed += 1;
        results.push({
          siteId: site.id,
          slug: site.slug,
          appUuid,
          configuredAfter: false,
          note: "provision_failed"
        });
      }
    }

    return NextResponse.json({
      ok: true,
      scanned: sites.length,
      alreadyConfigured,
      autoProvisioned,
      failed,
      selfHealing: {
        mappingsRepaired,
        mappingsStaleUnresolved,
        stagingEnvsEnsured,
        stagingResourcesFlagged,
        resourcesMissing
      },
      results
    });
  } catch (error) {
    console.error("POST /api/ops/backup-reconcile error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
