import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { ensureCoolifyAppBackupSchedules, hasCoolifyBackupableState, describeCoolifyBackupCapability } from "@/lib/coolify";
import { buildLiveResourceIndex, reconcileSite } from "@/lib/platform-reconcile";
import { decideSiteArchive, shouldAbortArchiveBatch, orderDueBackups } from "@/lib/platform-reconcile-match";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { openJobLog } from "@/lib/job-log";

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
    let skipped = 0;
    let failed = 0;

    // Outcomes that are NOT failures: there is simply nothing for Coolify to
    // schedule. Counting these as failed made 16 benign apps mask 7 real ones.
    const BENIGN_NOTES = new Set([
      "no_databases_detected",
      "no_addressable_databases",
      "service_databases_not_schedulable"
    ]);
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
        } else if (reconciliation.note && BENIGN_NOTES.has(reconciliation.note)) {
          skipped += 1;
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

    // ── Scheduled backups ──
    // At most a few per pass, most-overdue first: backing up many WordPress
    // sites simultaneously would exhaust the host (a concurrent backup already
    // OOM-killed a deploy here), and an hourly pass spreads a daily schedule
    // across the day naturally.
    const scheduleDefaultOn = (process.env.JONGO_SCHEDULED_BACKUPS || "").trim() === "true";
    const maxBackupsPerRun = Number(process.env.JONGO_SCHEDULED_BACKUPS_PER_RUN || 1) || 1;
    const scheduledStarted: string[] = [];
    const scheduleSkipped: string[] = [];

    // Keep every app's backup capability fresh, not just ones due for a backup.
    // The UI reads these cached columns to decide whether to offer backup
    // features at all, so a stale or absent value means an app with nothing to
    // back up still shows a Backups tab it can do nothing with. One API call
    // per app per day, and it covers apps added later with no extra wiring.
    const CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000;
    // Bounded per pass and paced, so a 43-app sweep cannot exhaust Coolify's
    // rate limit. The hourly cadence still refreshes every app well inside the
    // 24h TTL.
    const CAPABILITY_MAX_PER_RUN = Number(process.env.JONGO_CAPABILITY_MAX_PER_RUN || 20) || 20;
    const CAPABILITY_PROBE_DELAY_MS = Number(process.env.JONGO_CAPABILITY_PROBE_DELAY_MS || 400) || 400;
    let capabilityRefreshed = 0;
    let capabilityUnknown = 0;
    {
      const rows = await db.site.findMany({
        where: { deletedAt: null, NOT: [{ coolifyServiceUuid: null }] },
        select: { id: true, coolifyServiceUuid: true, backupEligibleAt: true }
      });
      for (const row of rows) {
        const uuid = row.coolifyServiceUuid?.trim();
        if (!uuid) continue;
        const checkedAt = row.backupEligibleAt ? new Date(row.backupEligibleAt).getTime() : 0;
        if (Date.now() - checkedAt <= CAPABILITY_TTL_MS) continue;
        try {
          const cap = await describeCoolifyBackupCapability(uuid);
          // Never persist "unknown". Coolify rate limits (429) under a
          // platform-wide sweep, and caching that as an answer is what made
          // apps with a database report having nothing to back up.
          if (cap.reason === "unknown") {
            capabilityUnknown += 1;
            continue;
          }
          await db.$executeRaw`UPDATE "Site" SET "backupEligible" = ${cap.backupable}, "backupCapabilityReason" = ${cap.reason}, "backupEligibleAt" = now() WHERE id = ${row.id}::uuid`;
          capabilityRefreshed += 1;
        } catch {
          capabilityUnknown += 1;
        }
        // Space the probes out: this loop is the heaviest API user on the
        // platform, and hammering Coolify is what produced the 429s that made
        // the answers wrong in the first place.
        await new Promise((resolve) => setTimeout(resolve, CAPABILITY_PROBE_DELAY_MS));
        if (capabilityRefreshed + capabilityUnknown >= CAPABILITY_MAX_PER_RUN) break;
      }
    }

    // Nest database resources inside the app that owns them. Coolify registers
    // a standalone database as its own resource, so it was imported as a peer
    // app and listed beside the app whose data it holds. Rebuilt each pass from
    // live links, so it self-corrects and covers apps added later.
    let databasesNested = 0;
    let nestingProbes = 0;
    try {
      const all = await db.site.findMany({
        where: { deletedAt: null, NOT: [{ coolifyServiceUuid: null }] },
        select: {
          id: true,
          coolifyServiceUuid: true,
          parentSiteId: true,
          backupCapabilityReason: true
        }
      });
      const siteByUuid = new Map<string, { id: string; parentSiteId: string | null; reason: string | null }>();
      for (const row of all) {
        const uuid = row.coolifyServiceUuid?.trim();
        if (uuid) {
          siteByUuid.set(uuid, {
            id: row.id,
            parentSiteId: row.parentSiteId ?? null,
            reason: row.backupCapabilityReason ?? null
          });
        }
      }

      const { resolveCoolifyDatabaseUuids } = await import("@/lib/coolify");
      const desiredParent = new Map<string, string>(); // db site id -> owning site id
      for (const row of all) {
        const uuid = row.coolifyServiceUuid?.trim();
        if (!uuid) continue;
        if (nestingProbes >= CAPABILITY_MAX_PER_RUN) break; // same API budget
        let linked: string[] = [];
        try {
          linked = await resolveCoolifyDatabaseUuids(uuid);
          nestingProbes += 1;
          await new Promise((resolve) => setTimeout(resolve, CAPABILITY_PROBE_DELAY_MS));
        } catch {
          continue; // leave existing nesting alone rather than unparent on a blip
        }
        for (const dbUuid of linked) {
          if (dbUuid === uuid) continue; // a database does not own itself
          const target = siteByUuid.get(dbUuid);
          if (!target) continue;
          // Only ever nest a resource Coolify calls a standalone database.
          // Nesting hides it from the app list, so a wrong parent would make a
          // real app disappear; requiring a positive database classification
          // means an unknown resource stays visible at the top level.
          if (target.reason !== "standalone_database") continue;
          // First app to claim it wins; a shared database keeps a stable home
          // rather than flipping between owners on every pass.
          if (!desiredParent.has(target.id)) desiredParent.set(target.id, row.id);
        }
      }

      for (const [dbSiteId, ownerId] of desiredParent) {
        const current = all.find((r: { id: string }) => r.id === dbSiteId)?.parentSiteId ?? null;
        if (current === ownerId) continue;
        await db.$executeRaw`UPDATE "Site" SET "parentSiteId" = ${ownerId}::uuid WHERE id = ${dbSiteId}::uuid`;
        databasesNested += 1;
      }
    } catch {
      // Nesting is presentational; never let it break reconciliation.
    }

    // Runs unconditionally: orderDueBackups honours per-site opt-in even when
    // the platform default is off, so a site can enable backups on its own.
    {
      const scheduleRows = await db.site.findMany({
        where: { deletedAt: null, isStagingResource: false, NOT: [{ coolifyServiceUuid: null }] },
        select: {
          id: true, slug: true, name: true, coolifyServiceUuid: true,
          backupScheduleEnabled: true, backupFrequencyHours: true, lastScheduledBackupAt: true,
          backupEligible: true, backupEligibleAt: true
        }
      });
      // Uncapped and ordered: ineligible sites are filtered inside the loop, so
      // capping here would let stateless apps eat the whole per-run budget.
      const due = orderDueBackups(scheduleRows, { platformDefaultEnabled: scheduleDefaultOn });

      const backupScript = [
        path.join(process.cwd(), "scripts", "site-backup.mjs"),
        path.join(process.cwd(), "..", "scripts", "site-backup.mjs"),
        path.join(process.cwd(), "..", "..", "scripts", "site-backup.mjs")
      ].find((c) => existsSync(c));

      const ELIGIBILITY_TTL_MS = 24 * 60 * 60 * 1000;
      for (const site of due) {
        if (!backupScript) break;
        if (scheduledStarted.length >= maxBackupsPerRun) break;
        const row = scheduleRows.find((r: { id: string }) => r.id === site.id);
        const uuid = row?.coolifyServiceUuid?.trim();
        if (!uuid) continue;

        // A stateless app has nothing to snapshot. Without this the scheduler
        // would manufacture a failed backup for it every single day, silently.
        const checkedAt = row.backupEligibleAt ? new Date(row.backupEligibleAt).getTime() : 0;
        let eligible = row.backupEligible;
        if (eligible === null || eligible === undefined || Date.now() - checkedAt > ELIGIBILITY_TTL_MS) {
          try {
            eligible = await hasCoolifyBackupableState(uuid);
          } catch {
            // Unknown, not ineligible: skip this pass rather than cache a guess.
            scheduleSkipped.push(`${row.slug}:eligibility_unknown`);
            continue;
          }
          await db.$executeRaw`UPDATE "Site" SET "backupEligible" = ${eligible}, "backupEligibleAt" = now() WHERE id = ${site.id}::uuid`;
        }
        if (!eligible) {
          scheduleSkipped.push(`${row.slug}:no_state_to_back_up`);
          continue;
        }

        // Never stack backups for the same site.
        const running = await (db as any).siteBackup.findFirst({
          where: { siteId: site.id, status: "running" }
        });
        if (running) continue;

        const record = await (db as any).siteBackup.create({
          data: { siteId: site.id, resourceUuid: uuid, trigger: "scheduled", status: "running" }
        });
        // Stamp immediately so a crashed run cannot cause a retry storm.
        await db.$executeRaw`UPDATE "Site" SET "lastScheduledBackupAt" = now() WHERE id = ${site.id}::uuid`;

        const jobLog = openJobLog("site-backup");
        const child = spawn(
          process.execPath,
          [backupScript, "--resource-uuid", uuid, "--backup-id", record.id,
           "--site-slug", row.slug, "--site-name", row.name],
          { cwd: process.cwd(), env: process.env, detached: true, stdio: ["ignore", jobLog, jobLog] }
        );
        child.unref();
        scheduledStarted.push(row.slug);
      }
    }

    // ── Lifecycle sync: retire sites whose Coolify resource is gone ──
    // Opt-in (JONGO_ARCHIVE_MISSING_SITES=true). Soft delete only, after a
    // grace period, on a complete index, and refused entirely if an implausible
    // share of sites look deleted at once.
    const archiveEnabled = (process.env.JONGO_ARCHIVE_MISSING_SITES || "").trim() === "true";
    const graceDays = Number(process.env.JONGO_ARCHIVE_GRACE_DAYS || 7);
    let archiveCandidates: Array<{ id: string; slug: string }> = [];
    let archived = 0;
    let archiveAborted: string | null = null;

    if (liveIndex.complete !== false) {
      const stale = await db.site.findMany({
        where: { deletedAt: null, NOT: [{ resourceMissingSince: null }] },
        select: { id: true, slug: true, resourceMissingSince: true }
      });
      archiveCandidates = stale
        .filter((row: { resourceMissingSince: Date | null }) =>
          decideSiteArchive({
            missingSince: row.resourceMissingSince,
            graceDays: Number.isFinite(graceDays) ? graceDays : 7,
            indexComplete: true
          }).archive
        )
        .map((row: { id: string; slug: string }) => ({ id: row.id, slug: row.slug }));

      const breaker = shouldAbortArchiveBatch({
        candidates: archiveCandidates.length,
        totalSites: sites.length
      });
      if (breaker.abort) {
        archiveAborted = breaker.reason;
      } else if (archiveEnabled) {
        for (const candidate of archiveCandidates) {
          await db.$executeRaw`UPDATE "Site" SET "deletedAt" = now() WHERE id = ${candidate.id}::uuid AND "deletedAt" IS NULL`;
          archived += 1;
        }
      }
    }

    return NextResponse.json({
      ok: true,
      scanned: sites.length,
      scheduledBackups: {
        platformDefaultEnabled: scheduleDefaultOn,
        maxPerRun: maxBackupsPerRun,
        started: scheduledStarted,
        skipped: scheduleSkipped,
        capabilityRefreshed,
        capabilityUnknown,
        databasesNested
      },
      lifecycle: {
        indexComplete: liveIndex.complete !== false,
        archiveEnabled,
        graceDays,
        candidates: archiveCandidates.map((c) => c.slug),
        archived,
        abortedReason: archiveAborted
      },
      alreadyConfigured,
      autoProvisioned,
      skipped,
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
