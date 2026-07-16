import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { ensureCoolifyAppBackupSchedules } from "@/lib/coolify";

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
        coolifyServiceUuid: true
      },
      orderBy: { updatedAt: "desc" },
      take: limit
    });

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
      const appUuid = site.coolifyServiceUuid?.trim();
      if (!appUuid) {
        continue;
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
      results
    });
  } catch (error) {
    console.error("POST /api/ops/backup-reconcile error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
