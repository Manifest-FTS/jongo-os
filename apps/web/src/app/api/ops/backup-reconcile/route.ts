import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { ensureCoolifyAppBackupSchedules, hasCoolifyBackupableState, describeCoolifyBackupCapability } from "@/lib/coolify";
import { buildLiveResourceIndex, reconcileSite } from "@/lib/platform-reconcile";
import { archiveMissingSitesDefaultEnabled, decideSiteArchive, shouldAbortArchiveBatch, orderDueBackups } from "@/lib/platform-reconcile-match";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { openJobLog } from "@/lib/job-log";
import { isRateLimitError, isRateLimited } from "@/lib/coolify-rate-limit";
import { decideStaleRun, DEFAULT_STALE_RUN_HOURS } from "@/lib/stale-run";
import { orderDueRehearsals, DEFAULT_REHEARSAL_INTERVAL_DAYS } from "@/lib/backup-rehearsal";
import { scheduledBackupsDefaultEnabled } from "@/lib/backup-schedule";
import { notifyBackupEvent } from "@/lib/site-notify";
import { importLinkedCoolifyProjectSites } from "@/lib/coolify-project-import";

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
        stagingEnabled: true,
        scheduleCheckedAt: true
      },
      orderBy: { updatedAt: "desc" },
      take: limit
    });

    // Platform self-healing runs for EVERY site each pass, so apps created
    // later are reconciled automatically with no manual step. The live resource
    // index is fetched once per run rather than per site.
    // True when Coolify's 200/min limit was hit; the pass stops early and the
    // next hourly run continues where this one left off.
    let rateLimited = false;

    const liveIndex = await buildLiveResourceIndex();
    // An incomplete index means Coolify was already refusing calls before this
    // pass began. Everything downstream would be guesswork, so record it up
    // front instead of reporting a sweep that could not have worked.
    if (liveIndex.complete === false && isRateLimited()) {
      rateLimited = true;
    }

    // Coolify is the ownership source of truth. Only linked projects with an
    // active project ID match are eligible for automatic site import; name-based
    // matching is intentionally skipped so ownership stays deterministic.
    const IMPORT_PROJECT_SITES_MAX_PER_RUN = Number(process.env.JONGO_IMPORT_PROJECT_SITES_MAX_PER_RUN || 8) || 8;
    let projectSitesImported = 0;
    let projectSitesCreated = 0;
    let projectSitesUpdated = 0;
    let projectSitesSkipped = 0;
    try {
      const organizations = await db.organization.findMany({
        where: { deletedAt: null },
        select: { id: true },
        orderBy: { createdAt: "asc" }
      });

      for (const organization of organizations) {
        if (projectSitesImported >= IMPORT_PROJECT_SITES_MAX_PER_RUN) break;
        try {
          const importResult = await importLinkedCoolifyProjectSites(organization.id);
          projectSitesImported += 1;
          projectSitesCreated += importResult.createdSites;
          projectSitesUpdated += importResult.updatedSites;
          projectSitesSkipped += importResult.skippedSites;
          if (isRateLimited()) {
            rateLimited = true;
            break;
          }
        } catch (error) {
          if (isRateLimitError(error)) {
            rateLimited = true;
            break;
          }
        }
      }
    } catch {
      // Import is best-effort. Never let a linked-project sync failure break the
      // backup reconciliation pass that is already running.
    }

    let mappingsRepaired = 0;
    let mappingsStaleUnresolved = 0;
    let stagingEnvsEnsured = 0;
    let stagingResourcesFlagged = 0;
    let resourcesMissing = 0;

    // Budget for the schedule sweep. Deliberately smaller than the capability
    // sweep's: this data changes rarely, the UI does not read it live, and it
    // was the loop starving everything else.
    const SCHEDULE_TTL_MS = Number(process.env.JONGO_SCHEDULE_TTL_HOURS || 24) * 60 * 60 * 1000;
    const SCHEDULE_MAX_PER_RUN = Number(process.env.JONGO_SCHEDULE_MAX_PER_RUN || 8) || 8;
    let scheduleChecked = 0;
    let scheduleFresh = 0;
    let scheduleDeferred = 0;

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

    // Capability first, deliberately. Coolify allows 200 requests/minute per
    // token and a full pass exceeds that, so whatever ran last received nothing
    // but 429s — which is how apps with databases came to be recorded as having
    // nothing to back up. This is what the UI reads to decide whether to offer
    // backups at all, so it takes the budget before the schedule sweep, which
    // can wait an hour. Bounded and paced for the same reason.
    const CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000;
    // Sized against the real limit rather than by feel. Coolify allows 200
    // requests/minute (~3.3/sec) and one capability probe costs up to 4 calls,
    // so probes must not exceed roughly one per 1.2s. The previous 400ms spacing
    // was about three times over budget, which is why a pass still ended in 429s
    // even after it was "paced". 12 per pass refreshes all 43 apps in about four
    // hourly runs, well inside the 24h TTL.
    const CAPABILITY_MAX_PER_RUN = Number(process.env.JONGO_CAPABILITY_MAX_PER_RUN || 12) || 12;
    const CAPABILITY_PROBE_DELAY_MS = Number(process.env.JONGO_CAPABILITY_PROBE_DELAY_MS || 1500) || 1500;
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
            // describeCoolifyBackupCapability deliberately swallows probe
            // errors so page renders cannot throw, which means a rate limit
            // reaches us as a plain "unknown". Ask the breaker directly rather
            // than grinding through every remaining app learning nothing.
            if (isRateLimited()) {
              rateLimited = true;
              break;
            }
            continue;
          }
          await db.$executeRaw`UPDATE "Site" SET "backupEligible" = ${cap.backupable}, "backupCapabilityReason" = ${cap.reason}, "backupEligibleAt" = now() WHERE id = ${row.id}::uuid`;
          capabilityRefreshed += 1;
        } catch (error) {
          capabilityUnknown += 1;
          // Once rate limited, every further probe is wasted and keeps the
          // limiter pinned. Stop and let the next hourly pass continue.
          if (isRateLimitError(error)) {
            rateLimited = true;
            break;
          }
        }
        // Space the probes out: this loop is the heaviest API user on the
        // platform, and hammering Coolify is what produced the 429s that made
        // the answers wrong in the first place.
        await new Promise((resolve) => setTimeout(resolve, CAPABILITY_PROBE_DELAY_MS));
        if (capabilityRefreshed + capabilityUnknown >= CAPABILITY_MAX_PER_RUN) break;
      }
    }


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

      // Coolify's schedules do not change on their own, so re-checking every
      // app hourly spent the whole rate-limit budget to learn nothing. A day's
      // TTL plus a per-pass cap keeps it correct and affordable; self-healing
      // above still runs for every app on every pass, because that is cheap.
      const scheduleCheckedAt = site.scheduleCheckedAt ? new Date(site.scheduleCheckedAt).getTime() : 0;
      if (Date.now() - scheduleCheckedAt <= SCHEDULE_TTL_MS) {
        scheduleFresh += 1;
        continue;
      }
      if (scheduleChecked >= SCHEDULE_MAX_PER_RUN) {
        scheduleDeferred += 1;
        continue;
      }

      try {
        const reconciliation = await ensureCoolifyAppBackupSchedules(appUuid);
        scheduleChecked += 1;
        await db.$executeRaw`UPDATE "Site" SET "scheduleCheckedAt" = now() WHERE id = ${site.id}::uuid`;
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
      } catch (error) {
        if (isRateLimitError(error)) {
          rateLimited = true;
          results.push({ siteId: site.id, slug: site.slug, appUuid, configuredAfter: false, note: "rate_limited" });
          break;
        }
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

    // ── Abandon runs that died without reporting ──
    // Must come before scheduled backups: the create path refuses to start
    // while a run says "running", so one orphaned row silently ends backups for
    // that site forever. Backup and restore jobs are detached children of this
    // process, so a deploy or an OOM kill orphans them with no other trace.
    const staleAfterHours = Number(process.env.JONGO_STALE_RUN_HOURS || DEFAULT_STALE_RUN_HOURS) || DEFAULT_STALE_RUN_HOURS;
    let backupsAbandoned = 0;
    let restoresAbandoned = 0;
    try {
      const now = new Date();
      const inFlight = await (db as any).siteBackup.findMany({
        where: { OR: [{ status: "running" }, { restoreStatus: "running" }] },
        select: { id: true, status: true, startedAt: true, restoreStatus: true, restoreStartedAt: true }
      });

      for (const run of inFlight ?? []) {
        const backupDecision = decideStaleRun({
          status: run.status,
          startedAt: run.startedAt,
          now,
          staleAfterHours
        });
        if (backupDecision.abandon) {
          await (db as any).siteBackup.update({
            where: { id: run.id },
            data: {
              status: "failed",
              completedAt: now,
              error: `Backup stopped reporting after ${backupDecision.ageHours}h and was marked failed. It may have been interrupted by a deploy or restart.`
            }
          });
          backupsAbandoned += 1;
        }

        const restoreDecision = decideStaleRun({
          status: run.restoreStatus,
          startedAt: run.restoreStartedAt,
          now,
          staleAfterHours
        });
        if (restoreDecision.abandon) {
          await (db as any).siteBackup.update({
            where: { id: run.id },
            data: {
              restoreStatus: "failed",
              restoreCompletedAt: now,
              restoreError: `Restore stopped reporting after ${restoreDecision.ageHours}h and was marked failed. Check the site before retrying — it may have been interrupted part-way through.`
            }
          });
          restoresAbandoned += 1;
        }
      }
    } catch {
      // Never let the sweep break reconciliation; it retries next pass.
    }

    // ── Scheduled backups ──
    // At most a few per pass, most-overdue first: backing up many WordPress
    // sites simultaneously would exhaust the host (a concurrent backup already
    // OOM-killed a deploy here), and an hourly pass spreads a daily schedule
    // across the day naturally.
    const scheduleDefaultOn = scheduledBackupsDefaultEnabled();
    const maxBackupsPerRun = Number(process.env.JONGO_SCHEDULED_BACKUPS_PER_RUN || 1) || 1;
    const scheduledStarted: string[] = [];
    const scheduleSkipped: string[] = [];

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
        } catch (error) {
          if (isRateLimitError(error)) { rateLimited = true; break; }
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

        // This path creates its own siteBackup row rather than going through
        // startSiteBackup, so the started notification has to be emitted here
        // too — otherwise the scheduled backups, which are most of them, would
        // be the only ones that never announced themselves.
        await notifyBackupEvent({ siteId: site.id, event: "backup_started", trigger: "scheduled" });
      }
    }

    // ── WordPress plugin inventory ──
    // Reads each WordPress app's plugins straight from its container, so the
    // Plugins page works for apps that have no REST application password (which
    // was all but a handful of them). Capped per run and ordered stalest-first:
    // each probe is an SSH round trip, and the whole fleet every hour would put
    // more load on the host than the page is worth.
    let pluginInventoryRefreshed = 0;
    let pluginInventoryFailed = 0;
    const pluginInventorySkipped: string[] = [];
    try {
      const PLUGIN_INVENTORY_MAX_PER_RUN = Number(process.env.JONGO_PLUGIN_INVENTORY_MAX_PER_RUN || 12) || 12;
      const { isSshHostConfigured } = await import("@/lib/ssh-exec");

      if (!isSshHostConfigured()) {
        pluginInventorySkipped.push("ssh_host_not_configured");
      } else {
        const { refreshPluginInventory, PLUGIN_INVENTORY_REFRESH_AFTER_MINUTES } = await import(
          "@/lib/wordpress-plugin-inventory"
        );
        const staleBefore = new Date(Date.now() - PLUGIN_INVENTORY_REFRESH_AFTER_MINUTES * 60_000);

        const baseWhere = { deletedAt: null, isStagingResource: false, NOT: [{ coolifyServiceUuid: null }] };
        const selection = { id: true, slug: true, coolifyServiceUuid: true };

        // Two queries rather than one OR with an ordered relation: Postgres sorts
        // NULLS LAST on an ascending order, so a never-collected app would rank
        // behind every stale one and a newly added site could wait a long time
        // for its first reading. Asking for the missing ones explicitly first is
        // both correct and obvious.
        const missing = await db.site.findMany({
          where: { ...baseWhere, wordpressPluginInventory: { is: null } },
          select: selection,
          take: PLUGIN_INVENTORY_MAX_PER_RUN
        });

        const remaining = PLUGIN_INVENTORY_MAX_PER_RUN - missing.length;
        const stale = remaining > 0
          ? await db.site.findMany({
              where: { ...baseWhere, wordpressPluginInventory: { collectedAt: { lt: staleBefore } } },
              select: selection,
              orderBy: { wordpressPluginInventory: { collectedAt: "asc" } },
              take: remaining
            })
          : [];

        const candidates = [...missing, ...stale];

        for (const candidate of candidates) {
          const uuid = candidate.coolifyServiceUuid?.trim();
          if (!uuid) continue;
          const result = await refreshPluginInventory({ siteDbId: candidate.id, resourceUuid: uuid });
          if (result.status === "ok") pluginInventoryRefreshed += 1;
          else if (result.status === "deferred_deploy_in_progress") pluginInventorySkipped.push(`${candidate.slug}:deferred`);
          else pluginInventoryFailed += 1;
        }

        // Say what was left out. A capped sweep that reports only successes reads
        // as "the fleet is covered" when it is not.
        if (candidates.length >= PLUGIN_INVENTORY_MAX_PER_RUN) {
          pluginInventorySkipped.push(`per_run_cap_reached:${PLUGIN_INVENTORY_MAX_PER_RUN}`);
        }
      }
    } catch (error) {
      pluginInventorySkipped.push(
        `error:${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`
      );
    }

    // ── Backup rehearsal ──
    // Restores one backup into a throwaway container to find out whether it
    // would actually restore. Nothing else on the platform verifies the restic
    // snapshots the catalogue advertises: restore-test-resource.mjs checks
    // Coolify's own dumps, which is a different artifact entirely.
    //
    // Opt-in, and one per pass. It starts a database container on the
    // production host, so the blast radius stays small and predictable until
    // it has proven itself in place.
    const rehearsalEnabled = (process.env.JONGO_BACKUP_REHEARSAL || "").trim() === "true";
    const rehearsalIntervalDays = Number(process.env.JONGO_REHEARSAL_INTERVAL_DAYS || DEFAULT_REHEARSAL_INTERVAL_DAYS)
      || DEFAULT_REHEARSAL_INTERVAL_DAYS;
    let rehearsalStarted: string | null = null;
    let rehearsalsDue = 0;
    if (rehearsalEnabled) {
      try {
        const rehearsalScript = [
          path.join(process.cwd(), "scripts", "backup-rehearsal.mjs"),
          path.join(process.cwd(), "..", "scripts", "backup-rehearsal.mjs"),
          path.join(process.cwd(), "..", "..", "scripts", "backup-rehearsal.mjs")
        ].find((c) => existsSync(c));

        if (rehearsalScript) {
          const rehearsalSites = await db.site.findMany({
            where: { deletedAt: null, isStagingResource: false, NOT: [{ coolifyServiceUuid: null }] },
            select: { id: true, slug: true, coolifyServiceUuid: true }
          });

          // Most recent restorable backup per site. Ordered newest-first and
          // reduced in JS: the alternative is one query per site, and this loop
          // already shares Coolify's rate-limit budget with everything above.
          const recent = await (db as any).siteBackup.findMany({
            where: { status: "success", NOT: [{ resticSnapshotId: null }] },
            orderBy: { completedAt: "desc" },
            select: { id: true, siteId: true, resticSnapshotId: true },
            take: 500
          });
          const latestBySite = new Map<string, { id: string; resticSnapshotId: string }>();
          for (const row of recent ?? []) {
            if (!latestBySite.has(row.siteId)) {
              latestBySite.set(row.siteId, { id: row.id, resticSnapshotId: row.resticSnapshotId });
            }
          }

          const verifications = await (db as any).backupRestoreVerification.findMany({
            select: { resourceUuid: true, lastVerifiedAt: true }
          });
          const verifiedAt = new Map<string, Date>();
          for (const v of verifications ?? []) verifiedAt.set(v.resourceUuid, v.lastVerifiedAt);

          const due = orderDueRehearsals(
            rehearsalSites.map((site: { id: string; slug: string; coolifyServiceUuid: string | null }) => {
              const latest = latestBySite.get(site.id);
              return {
                resourceUuid: site.coolifyServiceUuid?.trim() ?? "",
                slug: site.slug,
                lastVerifiedAt: verifiedAt.get(site.coolifyServiceUuid?.trim() ?? "") ?? null,
                backupId: latest?.id ?? null,
                snapshotId: latest?.resticSnapshotId ?? null
              };
            }),
            { intervalDays: rehearsalIntervalDays }
          );
          rehearsalsDue = due.length;

          const next = due[0];
          if (next) {
            const jobLog = openJobLog("backup-rehearsal");
            const child = spawn(
              process.execPath,
              [
                rehearsalScript,
                "--snapshot-id", String(next.snapshotId),
                "--resource-uuid", next.resourceUuid,
                "--backup-id", String(next.backupId)
              ],
              { cwd: process.cwd(), env: process.env, detached: true, stdio: ["ignore", jobLog, jobLog] }
            );
            child.unref();
            rehearsalStarted = next.slug ?? next.resourceUuid;
          }
        }
      } catch {
        // Verification must never break the pass that produces the backups.
      }
    }

    // ── Lifecycle sync: retire sites whose Coolify resource is gone ──
    // On by default (JONGO_ARCHIVE_MISSING_SITES=false to opt out). Soft delete
    // only, after a grace period, on a complete index, and refused entirely if an
    // implausible share of sites look deleted at once.
    const archiveEnabled = archiveMissingSitesDefaultEnabled();
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
      scheduleSweep: { checked: scheduleChecked, freshSkipped: scheduleFresh, deferred: scheduleDeferred },
      abandonedRuns: { backups: backupsAbandoned, restores: restoresAbandoned, staleAfterHours },
      rehearsal: {
        enabled: rehearsalEnabled,
        intervalDays: rehearsalIntervalDays,
        due: rehearsalsDue,
        started: rehearsalStarted
      },
      linkedProjectImport: {
        maxPerRun: IMPORT_PROJECT_SITES_MAX_PER_RUN,
        processed: projectSitesImported,
        created: projectSitesCreated,
        updated: projectSitesUpdated,
        skipped: projectSitesSkipped,
        rateLimited
      },
      scheduledBackups: {
        platformDefaultEnabled: scheduleDefaultOn,
        maxPerRun: maxBackupsPerRun,
        started: scheduledStarted,
        skipped: scheduleSkipped,
        capabilityRefreshed,
        capabilityUnknown,
        databasesNested,
        rateLimited
      },
      pluginInventory: {
        refreshed: pluginInventoryRefreshed,
        failed: pluginInventoryFailed,
        skipped: pluginInventorySkipped
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
