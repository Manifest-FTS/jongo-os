/**
 * Reading and writing usage.
 *
 * Collection: run scripts/usage-collect.sh on the Docker host over the same SSH
 * channel backups use, hand the output to usage-parse.ts, and write what it
 * returns. Everything that decides a number lives in usage-parse.ts; this file
 * only moves it into Postgres.
 *
 * Writes happen in ONE transaction behind an advisory lock, and the counter
 * state is re-read INSIDE that lock. Two Jongo replicas both run the scheduler;
 * without the lock they would read the same previous counters, compute the same
 * delta, and bill every CPU-second twice.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { getDb } from "@/lib/db";
import { runHostScript } from "@/lib/ssh-exec";
import {
  computeLive,
  computeRun,
  parseCollectorOutput,
  type CounterState,
  type LiveSnapshot,
  type SiteRef
} from "@/lib/usage-parse";

/*
 * TIME ZONES: every timestamp column here is TIMESTAMP WITHOUT TIME ZONE holding
 * UTC, which is how Prisma reads and writes them. Raw SQL must therefore convert
 * explicitly — `to_timestamp(x) AT TIME ZONE 'UTC'` on the way in, and
 * `${date}::timestamptz AT TIME ZONE 'UTC'` in comparisons. Left implicit,
 * Postgres uses the SESSION time zone: on a non-UTC server every reading is
 * stored hours in the future, the next reading looks older than the stored one,
 * and it is skipped as stale — so no CPU or traffic is ever recorded.
 */

/** Arbitrary constant; must be unique to usage collection across the app. */
const USAGE_LOCK_ID = 4_711_301;
const DISK_MARKER_KEY = "d:last";

function toNum(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  if (typeof value === "object" && value && "toNumber" in value) return (value as { toNumber(): number }).toNumber();
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toNumOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : toNum(value);
}

function resolveCollectorScript(): string | null {
  const cwd = process.cwd();
  return [
    path.join(cwd, "scripts", "usage-collect.sh"),
    path.join(cwd, "..", "scripts", "usage-collect.sh"),
    path.join(cwd, "..", "..", "scripts", "usage-collect.sh")
  ].find((candidate) => existsSync(candidate)) ?? null;
}

async function runCollector(vars: Record<string, string>, timeoutMs: number) {
  const scriptPath = resolveCollectorScript();
  if (!scriptPath) return { ok: false as const, error: "scripts/usage-collect.sh not found" };
  const prelude = Object.entries(vars).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("\n");
  const result = await runHostScript(`${prelude}\n${readFileSync(scriptPath, "utf8")}`, { timeoutMs });
  if (result.transportError) return { ok: false as const, error: result.transportError };
  if (!result.stdout.trim()) return { ok: false as const, error: result.stderr.trim() || "collector produced no output" };
  return { ok: true as const, stdout: result.stdout };
}

type SiteRow = { id: string; coolifyServiceUuid: string | null; name: string; organizationId: string; parentSiteId: string | null; deletedAt: Date | null };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadSites(db: any): Promise<{ byUuid: Map<string, SiteRef>; all: SiteRow[] }> {
  // Deleted apps are included on purpose: if their containers are still running
  // they are still costing money, and a cost audit should say so.
  const rows: SiteRow[] = await db.site.findMany({
    where: { coolifyServiceUuid: { not: null } },
    select: { id: true, coolifyServiceUuid: true, name: true, organizationId: true, parentSiteId: true, deletedAt: true }
  });
  const map = new Map<string, SiteRef>();
  for (const r of rows) {
    const uuid = r.coolifyServiceUuid?.trim().toLowerCase();
    if (!uuid) continue;
    const existing = map.get(uuid);
    // Several rows can share a uuid (duplicates, soft-deleted copies). Prefer a live one.
    if (existing && !r.deletedAt) continue;
    map.set(uuid, {
      id: r.id,
      coolifyServiceUuid: uuid,
      name: r.deletedAt ? `${r.name} (deleted)` : r.name,
      organizationId: r.organizationId,
      parentSiteId: r.parentSiteId
    });
  }
  // A live row wins over a deleted duplicate.
  for (const r of rows) {
    const uuid = r.coolifyServiceUuid?.trim().toLowerCase();
    if (uuid && !r.deletedAt) {
      map.set(uuid, { id: r.id, coolifyServiceUuid: uuid, name: r.name, organizationId: r.organizationId, parentSiteId: r.parentSiteId });
    }
  }
  return { byUuid: map, all: rows };
}

export type CollectResult =
  | {
      ok: true;
      host: string;
      containers: number;
      subjects: number;
      withDisk: boolean;
      skippedStale: number;
      droppedGaps: number;
      rejectedLines: number;
      durationMs: number;
    }
  | { ok: true; skipped: true; reason: string }
  | { ok: false; error: string };

export async function collectUsage(options: { forceDisk?: boolean } = {}): Promise<CollectResult> {
  const started = Date.now();
  const db = await getDb();
  if (!db) return { ok: false, error: "database unavailable" };

  // Two replicas both run the scheduler. Their deltas are safe (see the lock
  // below) but there is no point SSHing twice a minute apart.
  const minGapSeconds = Math.max(0, Number(process.env.USAGE_MIN_GAP_SECONDS ?? 120) || 0);
  if (!options.forceDisk && minGapSeconds > 0) {
    const latest = await db.usageCounterState.findFirst({
      where: { key: { startsWith: "h:" } },
      orderBy: { collectedAt: "desc" },
      select: { collectedAt: true }
    });
    const ageSeconds = latest ? (Date.now() - latest.collectedAt.getTime()) / 1000 : Infinity;
    if (ageSeconds < minGapSeconds) {
      return { ok: true, skipped: true, reason: `last reading ${Math.round(ageSeconds)}s ago` };
    }
  }

  const diskEveryMinutes = Math.max(15, Number(process.env.USAGE_DISK_INTERVAL_MINUTES || 60) || 60);
  const marker = await db.usageCounterState.findUnique({ where: { key: DISK_MARKER_KEY } });
  const withDisk = options.forceDisk || !marker || Date.now() - marker.collectedAt.getTime() >= diskEveryMinutes * 60_000;

  const collected = await runCollector({ USAGE_DISK: withDisk ? "1" : "0" }, withDisk ? 240_000 : 90_000);
  if (!collected.ok) return { ok: false, error: collected.error };

  const output = parseCollectorOutput(collected.stdout);
  const { byUuid: sitesByUuid } = await loadSites(db);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const summary = await db.$transaction(async (tx: any) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${USAGE_LOCK_ID})`;

    const host = output.passes[output.passes.length - 1]?.host?.host;
    if (!host) return null;
    const stateRows: Array<{
      key: string; collectedAt: Date; startedAt: Date | null; cpuUsec: bigint; netRxBytes: bigint; netTxBytes: bigint;
    }> = await tx.usageCounterState.findMany({ where: { host } });
    const states = new Map<string, CounterState>(
      stateRows.map((s) => [
        s.key,
        {
          key: s.key,
          collectedAt: Math.floor(s.collectedAt.getTime() / 1000),
          startedAt: s.startedAt ? s.startedAt.toISOString() : null,
          cpuUsec: toNum(s.cpuUsec),
          netRx: toNum(s.netRxBytes),
          netTx: toNum(s.netTxBytes)
        }
      ])
    );

    const run = computeRun({ output, states, sitesByUuid, withDisk });
    if (!run) return null;

    if (run.increments.length) {
      const inc = run.increments;
      await tx.$executeRaw`
        INSERT INTO "UsageHourly" (
          "hourStart", "host", "subjectKey", "siteId", "label", "cpuCoreSeconds",
          "memSumBytes", "memSamples", "memPeakBytes", "netRxBytes", "netTxBytes",
          "egressBytes", "diskBytes", "containers", "updatedAt"
        )
        SELECT (to_timestamp(t.h) AT TIME ZONE 'UTC'), ${run.host}, t.k, t.s::uuid, t.l, t.cpu,
               t.msum::bigint, t.mn, t.mpeak::bigint, t.rx::bigint, t.tx::bigint,
               t.eg::bigint, t.disk::bigint, t.cn, now()
        FROM unnest(
          ${inc.map((i) => i.hourStart)}::float8[],
          ${inc.map((i) => i.subjectKey)}::text[],
          ${inc.map((i) => i.siteId)}::text[],
          ${inc.map((i) => i.label)}::text[],
          ${inc.map((i) => i.cpuCoreSeconds)}::float8[],
          ${inc.map((i) => Math.round(i.memSumBytes))}::float8[],
          ${inc.map((i) => i.memSamples)}::int[],
          ${inc.map((i) => Math.round(i.memPeakBytes))}::float8[],
          ${inc.map((i) => Math.round(i.netRxBytes))}::float8[],
          ${inc.map((i) => Math.round(i.netTxBytes))}::float8[],
          ${inc.map((i) => Math.round(i.egressBytes))}::float8[],
          ${inc.map((i) => (i.diskBytes === null ? null : Math.round(i.diskBytes)))}::float8[],
          ${inc.map((i) => i.containers)}::int[]
        ) AS t(h, k, s, l, cpu, msum, mn, mpeak, rx, tx, eg, disk, cn)
        ON CONFLICT ("hourStart", "host", "subjectKey") DO UPDATE SET
          "siteId"         = EXCLUDED."siteId",
          "label"          = EXCLUDED."label",
          "cpuCoreSeconds" = "UsageHourly"."cpuCoreSeconds" + EXCLUDED."cpuCoreSeconds",
          "memSumBytes"    = "UsageHourly"."memSumBytes" + EXCLUDED."memSumBytes",
          "memSamples"     = "UsageHourly"."memSamples" + EXCLUDED."memSamples",
          "memPeakBytes"   = GREATEST("UsageHourly"."memPeakBytes", EXCLUDED."memPeakBytes"),
          "netRxBytes"     = "UsageHourly"."netRxBytes" + EXCLUDED."netRxBytes",
          "netTxBytes"     = "UsageHourly"."netTxBytes" + EXCLUDED."netTxBytes",
          "egressBytes"    = "UsageHourly"."egressBytes" + EXCLUDED."egressBytes",
          "diskBytes"      = COALESCE(EXCLUDED."diskBytes", "UsageHourly"."diskBytes"),
          "containers"     = GREATEST("UsageHourly"."containers", EXCLUDED."containers"),
          "updatedAt"      = now()`;
    }

    for (const h of run.hostIncrements) {
      const sample = h.memUsedBytes > 0 ? 1 : 0;
      await tx.$executeRaw`
        INSERT INTO "UsageHostHourly" (
          "hourStart", "host", "coveredSeconds", "cpuCores", "cpuBusySeconds", "memTotalBytes", "memUsedSumBytes",
          "memSamples", "memUsedPeakBytes", "netRxBytes", "netTxBytes", "diskTotalBytes", "diskUsedBytes", "updatedAt"
        ) VALUES (
          (to_timestamp(${h.hourStart}) AT TIME ZONE 'UTC'), ${run.host}, ${h.coveredSeconds}, ${h.cpuCores}, ${h.cpuBusySeconds}, ${Math.round(h.memTotalBytes)}::float8::bigint,
          ${Math.round(h.memUsedBytes)}::float8::bigint, ${sample}, ${Math.round(h.memUsedBytes)}::float8::bigint,
          ${Math.round(h.netRxBytes)}::float8::bigint, ${Math.round(h.netTxBytes)}::float8::bigint,
          ${Math.round(h.diskTotalBytes)}::float8::bigint, ${Math.round(h.diskUsedBytes)}::float8::bigint, now()
        )
        ON CONFLICT ("hourStart", "host") DO UPDATE SET
          "coveredSeconds"   = "UsageHostHourly"."coveredSeconds" + EXCLUDED."coveredSeconds",
          "cpuCores"         = GREATEST("UsageHostHourly"."cpuCores", EXCLUDED."cpuCores"),
          "cpuBusySeconds"   = "UsageHostHourly"."cpuBusySeconds" + EXCLUDED."cpuBusySeconds",
          "memTotalBytes"    = GREATEST("UsageHostHourly"."memTotalBytes", EXCLUDED."memTotalBytes"),
          "memUsedSumBytes"  = "UsageHostHourly"."memUsedSumBytes" + EXCLUDED."memUsedSumBytes",
          "memSamples"       = "UsageHostHourly"."memSamples" + EXCLUDED."memSamples",
          "memUsedPeakBytes" = GREATEST("UsageHostHourly"."memUsedPeakBytes", EXCLUDED."memUsedPeakBytes"),
          "netRxBytes"       = "UsageHostHourly"."netRxBytes" + EXCLUDED."netRxBytes",
          "netTxBytes"       = "UsageHostHourly"."netTxBytes" + EXCLUDED."netTxBytes",
          "diskTotalBytes"   = CASE WHEN EXCLUDED."diskTotalBytes" > 0 THEN EXCLUDED."diskTotalBytes" ELSE "UsageHostHourly"."diskTotalBytes" END,
          "diskUsedBytes"    = CASE WHEN EXCLUDED."diskUsedBytes" > 0 THEN EXCLUDED."diskUsedBytes" ELSE "UsageHostHourly"."diskUsedBytes" END,
          "updatedAt"        = now()`;
    }

    if (run.nextStates.length) {
      const s = run.nextStates;
      await tx.$executeRaw`
        INSERT INTO "UsageCounterState" ("key", "host", "collectedAt", "startedAt", "cpuUsec", "netRxBytes", "netTxBytes", "updatedAt")
        SELECT t.k, ${run.host}, (to_timestamp(t.c) AT TIME ZONE 'UTC'), (t.st::timestamptz AT TIME ZONE 'UTC'), t.cpu::bigint, t.rx::bigint, t.tx::bigint, now()
        FROM unnest(
          ${s.map((x) => x.key)}::text[],
          ${s.map((x) => x.collectedAt)}::float8[],
          ${s.map((x) => x.startedAt)}::text[],
          ${s.map((x) => x.cpuUsec)}::float8[],
          ${s.map((x) => x.netRx)}::float8[],
          ${s.map((x) => x.netTx)}::float8[]
        ) AS t(k, c, st, cpu, rx, tx)
        ON CONFLICT ("key") DO UPDATE SET
          "collectedAt" = EXCLUDED."collectedAt", "startedAt" = EXCLUDED."startedAt",
          "cpuUsec" = EXCLUDED."cpuUsec", "netRxBytes" = EXCLUDED."netRxBytes",
          "netTxBytes" = EXCLUDED."netTxBytes", "updatedAt" = now()
        WHERE "UsageCounterState"."collectedAt" < EXCLUDED."collectedAt"`;
    }

    if (withDisk) {
      await tx.usageCounterState.upsert({
        where: { key: DISK_MARKER_KEY },
        create: { key: DISK_MARKER_KEY, host: run.host, collectedAt: new Date() },
        update: { collectedAt: new Date(), host: run.host }
      });
    }

    // Housekeeping: counters for containers gone two days, hourly rows past 400 days.
    await tx.$executeRaw`DELETE FROM "UsageCounterState" WHERE "key" LIKE 'c:%' AND "collectedAt" < (now() AT TIME ZONE 'UTC') - interval '2 days'`;
    await tx.$executeRaw`DELETE FROM "UsageHourly" WHERE "hourStart" < (now() AT TIME ZONE 'UTC') - interval '400 days'`;
    await tx.$executeRaw`DELETE FROM "UsageHostHourly" WHERE "hourStart" < (now() AT TIME ZONE 'UTC') - interval '400 days'`;

    return {
      host: run.host,
      containers: run.containerCount,
      subjects: new Set(run.increments.map((i) => i.subjectKey)).size,
      skippedStale: run.skippedStale,
      droppedGaps: run.droppedGaps
    };
  }, { timeout: 60_000, maxWait: 30_000 });

  if (!summary) return { ok: false, error: "collector output had no host reading" };
  const done = summary as { host: string; containers: number; subjects: number; skippedStale: number; droppedGaps: number };
  return {
    ok: true,
    ...done,
    withDisk,
    rejectedLines: output.rejected.length,
    durationMs: Date.now() - started
  };
}

// ---------------------------------------------------------------------------
// Live snapshot
// ---------------------------------------------------------------------------

/**
 * Fold a nested database's live reading into the app that owns it, so the live
 * panel and the hourly report group things the same way.
 */
export function rollUpLive(snapshot: LiveSnapshot, sites: Array<Pick<SiteRow, "id" | "name" | "parentSiteId">>): LiveSnapshot {
  const byId = new Map(sites.map((s) => [s.id, s]));
  const merged = new Map<string, LiveSnapshot["subjects"][number]>();
  for (const subject of snapshot.subjects) {
    const parent = subject.siteId ? byId.get(subject.siteId)?.parentSiteId : null;
    const root = parent ? byId.get(parent) : null;
    const key = root ? root.id : subject.subjectKey;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, root ? { ...subject, subjectKey: root.id, siteId: root.id, label: root.name } : { ...subject });
      continue;
    }
    existing.cpuCores += subject.cpuCores;
    existing.memoryBytes += subject.memoryBytes;
    existing.rxBytesPerSec += subject.rxBytesPerSec;
    existing.txBytesPerSec += subject.txBytesPerSec;
    existing.egressBytesPerSec += subject.egressBytesPerSec;
    existing.containers += subject.containers;
    if (subject.memoryLimitBytes) existing.memoryLimitBytes = (existing.memoryLimitBytes ?? 0) + subject.memoryLimitBytes;
  }
  return { ...snapshot, subjects: [...merged.values()] };
}

let liveCache: { at: number; snapshot: LiveSnapshot } | null = null;
let liveInFlight: Promise<LiveSnapshot | null> | null = null;
const LIVE_TTL_MS = 20_000;

/**
 * Current CPU / memory / traffic, from two readings two seconds apart.
 *
 * Cached for 20 seconds and shared by every viewer (each filters it to what they
 * may see), so a dashboard left open by ten people is one SSH call, not ten.
 */
export async function getLiveUsage(): Promise<LiveSnapshot | null> {
  if (liveCache && Date.now() - liveCache.at < LIVE_TTL_MS) return liveCache.snapshot;
  if (liveInFlight) return liveInFlight;
  liveInFlight = (async () => {
    try {
      const db = await getDb();
      if (!db) return null;
      const collected = await runCollector({ USAGE_LIVE_GAP: "2" }, 60_000);
      if (!collected.ok) return null;
      const sites = await loadSites(db);
      const raw = computeLive(parseCollectorOutput(collected.stdout), sites.byUuid);
      const snapshot = raw ? rollUpLive(raw, sites.all) : null;
      if (snapshot) liveCache = { at: Date.now(), snapshot };
      return snapshot;
    } finally {
      liveInFlight = null;
    }
  })();
  return liveInFlight;
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

/**
 * Apps a user may see usage for — null means everything (platform admin).
 *
 * Mirrors listSiteDirectory's scoping (org owner, org collaborator, or app
 * collaborator) but reads only the database: the directory also calls Coolify,
 * which a usage page has no need to wait on. Nested databases follow their app.
 */
export async function getVisibleSiteIds(viewer: { userId?: string; isPlatformAdmin: boolean }): Promise<string[] | null> {
  if (viewer.isPlatformAdmin) return null;
  if (!viewer.userId) return [];
  const db = await getDb();
  if (!db) return [];
  const userId = viewer.userId;
  const direct: Array<{ id: string }> = await db.site.findMany({
    where: {
      deletedAt: null,
      OR: [
        { organization: { deletedAt: null, OR: [{ ownerId: userId }, { collaborators: { some: { userId, deletedAt: null } } }] } },
        { collaborators: { some: { userId, deletedAt: null } } }
      ]
    },
    select: { id: true }
  });
  const ids = direct.map((s) => s.id);
  if (!ids.length) return [];
  const children: Array<{ id: string }> = await db.site.findMany({ where: { deletedAt: null, parentSiteId: { in: ids } }, select: { id: true } });
  return [...new Set([...ids, ...children.map((c) => c.id)])];
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export type UsageRow = {
  key: string;
  /** Root app id (a nested database is folded into its app). Null for infra/unmapped. */
  siteId: string | null;
  label: string;
  organizationId: string | null;
  organizationName: string | null;
  kind: "app" | "infra" | "unmapped";
  cpuCoreSeconds: number;
  memAvgBytes: number;
  memByteHours: number;
  memPeakBytes: number;
  egressBytes: number;
  netTxBytes: number;
  netRxBytes: number;
  diskBytes: number;
  hours: number;
};

export type UsageDay = {
  day: string; // YYYY-MM-DD (UTC)
  cpuCoreSeconds: number;
  memAvgBytes: number;
  egressBytes: number;
  diskBytes: number;
};

export type HostSummary = {
  host: string;
  coveredSeconds: number;
  cpuCores: number;
  cpuBusySeconds: number;
  memTotalBytes: number;
  memUsedAvgBytes: number;
  memUsedPeakBytes: number;
  netTxBytes: number;
  diskTotalBytes: number;
  diskUsedBytes: number;
  hours: number;
};

export type UsageReport = {
  available: boolean;
  from: Date;
  to: Date;
  days: number;
  /** Hours in the window that actually have data — the window fills from first collection. */
  hoursCovered: number;
  /** Seconds actually spanned by readings in the window: the denominator for averages. */
  measuredSeconds: number;
  firstDataAt: Date | null;
  lastDataAt: Date | null;
  rows: UsageRow[];
  daily: UsageDay[];
  hosts: HostSummary[];
};

export type UsageFilter = {
  days: number;
  /** Restrict to these apps (and their nested databases). null = no restriction. */
  visibleSiteIds: string[] | null;
  organizationId?: string | null;
  siteId?: string | null;
  /** Include platform overhead and unmapped containers (admins only). */
  includeInfra: boolean;
};

function emptyReport(from: Date, to: Date, days: number): UsageReport {
  return { available: false, from, to, days, hoursCovered: 0, measuredSeconds: 0, firstDataAt: null, lastDataAt: null, rows: [], daily: [], hosts: [] };
}

export async function getUsageReport(filter: UsageFilter): Promise<UsageReport> {
  const days = [30, 60, 90].includes(filter.days) ? filter.days : 30;
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const db = await getDb();
  if (!db) return emptyReport(from, to, days);

  // Which rows are in scope. Apps roll up to their root (a nested database is
  // part of the app that owns it); infra/unmapped rows have no site.
  const conditions: Prisma.Sql[] = [Prisma.sql`u."hourStart" >= (${from}::timestamptz AT TIME ZONE 'UTC') AND u."hourStart" < (${to}::timestamptz AT TIME ZONE 'UTC')`];
  if (!filter.includeInfra) conditions.push(Prisma.sql`u."siteId" IS NOT NULL`);
  if (filter.visibleSiteIds) {
    const ids = filter.visibleSiteIds.length ? filter.visibleSiteIds : ["00000000-0000-0000-0000-000000000000"];
    conditions.push(Prisma.sql`u."siteId" = ANY(${ids}::uuid[])`);
  }
  if (filter.siteId) {
    conditions.push(Prisma.sql`COALESCE(s."parentSiteId", u."siteId") = ${filter.siteId}::uuid`);
  }
  if (filter.organizationId) {
    conditions.push(Prisma.sql`s."organizationId" = ${filter.organizationId}::uuid`);
  }
  const where = Prisma.join(conditions, " AND ");

  try {
    const rows: Array<Record<string, unknown>> = await db.$queryRaw`
      WITH scoped AS (
        SELECT u.*, COALESCE(s."parentSiteId", u."siteId") AS "rootSiteId"
        FROM "UsageHourly" u
        LEFT JOIN "Site" s ON s.id = u."siteId"
        WHERE ${where}
      ),
      per_hour AS (
        SELECT COALESCE(sc."rootSiteId"::text, sc."subjectKey") AS gkey,
               MIN(sc."subjectKey") AS "subjectKey",
               sc."hourStart",
               SUM(sc."cpuCoreSeconds") AS cpu,
               SUM(sc."memSumBytes"::float8 / NULLIF(sc."memSamples", 0)) AS mem,
               SUM(sc."memPeakBytes")::float8 AS peak,
               SUM(sc."egressBytes")::float8 AS egress,
               SUM(sc."netTxBytes")::float8 AS tx,
               SUM(sc."netRxBytes")::float8 AS rx
        FROM scoped sc
        GROUP BY 1, sc."hourStart"
      ),
      disk_latest AS (
        SELECT DISTINCT ON (sc."subjectKey")
               COALESCE(sc."rootSiteId"::text, sc."subjectKey") AS gkey, sc."diskBytes"
        FROM scoped sc
        WHERE sc."diskBytes" IS NOT NULL
        ORDER BY sc."subjectKey", sc."hourStart" DESC
      ),
      disk_by_group AS (
        SELECT gkey, SUM("diskBytes")::float8 AS disk FROM disk_latest GROUP BY gkey
      )
      SELECT ph.gkey, MIN(ph."subjectKey") AS "subjectKey",
             SUM(ph.cpu) AS cpu, AVG(ph.mem) AS mem_avg, SUM(ph.mem) AS mem_byte_hours,
             MAX(ph.peak) AS mem_peak, SUM(ph.egress) AS egress, SUM(ph.tx) AS tx, SUM(ph.rx) AS rx,
             COUNT(*) AS hours, COALESCE(MAX(d.disk), 0) AS disk
      FROM per_hour ph
      LEFT JOIN disk_by_group d ON d.gkey = ph.gkey
      GROUP BY ph.gkey`;

    const daily: Array<Record<string, unknown>> = await db.$queryRaw`
      WITH scoped AS (
        SELECT u.* FROM "UsageHourly" u LEFT JOIN "Site" s ON s.id = u."siteId" WHERE ${where}
      ),
      per_hour AS (
        SELECT "hourStart",
               SUM("cpuCoreSeconds") AS cpu,
               SUM("memSumBytes"::float8 / NULLIF("memSamples", 0)) AS mem,
               SUM("egressBytes")::float8 AS egress
        FROM scoped GROUP BY "hourStart"
      ),
      disk_day AS (
        SELECT day, SUM(d)::float8 AS disk FROM (
          SELECT date_trunc('day', "hourStart") AS day, "subjectKey", MAX("diskBytes") AS d
          FROM scoped WHERE "diskBytes" IS NOT NULL GROUP BY 1, 2
        ) x GROUP BY day
      )
      SELECT to_char(date_trunc('day', ph."hourStart"), 'YYYY-MM-DD') AS day,
             SUM(ph.cpu) AS cpu, AVG(ph.mem) AS mem, SUM(ph.egress) AS egress,
             COALESCE(MAX(dd.disk), 0) AS disk
      FROM per_hour ph
      LEFT JOIN disk_day dd ON dd.day = date_trunc('day', ph."hourStart")
      GROUP BY 1 ORDER BY 1`;

    const hostRows: Array<Record<string, unknown>> = await db.$queryRaw`
      SELECT "host",
             MAX("cpuCores") AS cores, SUM("cpuBusySeconds") AS busy, SUM("coveredSeconds") AS covered_s,
             MAX("memTotalBytes")::float8 AS mem_total,
             SUM("memUsedSumBytes")::float8 / NULLIF(SUM("memSamples"), 0) AS mem_avg,
             MAX("memUsedPeakBytes")::float8 AS mem_peak,
             SUM("netTxBytes")::float8 AS tx,
             (ARRAY_AGG("diskTotalBytes" ORDER BY "hourStart" DESC))[1]::float8 AS disk_total,
             (ARRAY_AGG("diskUsedBytes" ORDER BY "hourStart" DESC))[1]::float8 AS disk_used,
             COUNT(*) AS hours
      FROM "UsageHostHourly"
      WHERE "hourStart" >= (${from}::timestamptz AT TIME ZONE 'UTC') AND "hourStart" < (${to}::timestamptz AT TIME ZONE 'UTC')
      GROUP BY "host"`;

    const bounds: Array<Record<string, unknown>> = await db.$queryRaw`
      SELECT MIN("hourStart") AS first, MAX("hourStart") AS last,
             COUNT(DISTINCT "hourStart") FILTER (WHERE "hourStart" >= (${from}::timestamptz AT TIME ZONE 'UTC')) AS covered
      FROM "UsageHostHourly"`;

    // Names for the app groups.
    const siteIds = rows.map((r) => String(r.gkey)).filter((k) => /^[0-9a-f-]{36}$/.test(k));
    type SiteLite = { id: string; name: string; deletedAt: Date | null; organization: { id: string; name: string } };
    const sites: SiteLite[] = siteIds.length
      ? await db.site.findMany({
          where: { id: { in: siteIds } },
          select: { id: true, name: true, deletedAt: true, organization: { select: { id: true, name: true } } }
        })
      : [];
    const siteById = new Map(sites.map((s) => [s.id, s]));
    const labels: Array<{ subjectKey: string; label: string }> = await db.$queryRaw`
      SELECT DISTINCT ON ("subjectKey") "subjectKey", "label" FROM "UsageHourly"
      WHERE "siteId" IS NULL ORDER BY "subjectKey", "hourStart" DESC`;
    const labelByKey = new Map(labels.map((l) => [l.subjectKey, l.label]));

    const usageRows: UsageRow[] = rows.map((r) => {
      const key = String(r.gkey);
      const site = siteById.get(key);
      const kind: UsageRow["kind"] = site ? "app" : key.startsWith("unmapped:") ? "unmapped" : "infra";
      return {
        key,
        siteId: site ? site.id : null,
        label: site ? `${site.name}${site.deletedAt ? " (deleted)" : ""}` : labelByKey.get(key) ?? key,
        organizationId: site?.organization.id ?? null,
        organizationName: site?.organization.name ?? null,
        kind,
        cpuCoreSeconds: toNum(r.cpu),
        memAvgBytes: toNum(r.mem_avg),
        memByteHours: toNum(r.mem_byte_hours),
        memPeakBytes: toNum(r.mem_peak),
        egressBytes: toNum(r.egress),
        netTxBytes: toNum(r.tx),
        netRxBytes: toNum(r.rx),
        diskBytes: toNum(r.disk),
        hours: toNum(r.hours)
      };
    });

    const b = bounds[0] ?? {};
    return {
      available: true,
      from,
      to,
      days,
      hoursCovered: toNum(b.covered),
      // Hosts are read concurrently, so the longest-measured one is the window.
      measuredSeconds: Math.max(0, ...hostRows.map((h) => toNum(h.covered_s))),
      firstDataAt: b.first ? new Date(b.first as string) : null,
      lastDataAt: b.last ? new Date(b.last as string) : null,
      rows: usageRows,
      daily: daily.map((d) => ({
        day: String(d.day),
        cpuCoreSeconds: toNum(d.cpu),
        memAvgBytes: toNum(d.mem),
        egressBytes: toNum(d.egress),
        diskBytes: toNum(d.disk)
      })),
      hosts: hostRows.map((h) => ({
        host: String(h.host),
        coveredSeconds: toNum(h.covered_s),
        cpuCores: toNum(h.cores),
        cpuBusySeconds: toNum(h.busy),
        memTotalBytes: toNum(h.mem_total),
        memUsedAvgBytes: toNum(h.mem_avg),
        memUsedPeakBytes: toNum(h.mem_peak),
        netTxBytes: toNum(h.tx),
        diskTotalBytes: toNum(h.disk_total),
        diskUsedBytes: toNum(h.disk_used),
        hours: toNum(h.hours)
      }))
    };
  } catch (error) {
    // Before the migration has run the tables do not exist. Say "no data", don't 500.
    console.error("[usage] report failed:", error instanceof Error ? error.message : error);
    return emptyReport(from, to, days);
  }
}

export { toNumOrNull };
