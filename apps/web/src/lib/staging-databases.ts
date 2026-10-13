/**
 * Staging databases for apps (docs/superpowers/specs/2026-10-13-staging-databases-design.md).
 *
 * ensureStagingDatabases: for every platform database the production app
 * uses, make sure the staging app has its own copy (create it the first time),
 * point the staging app's variables at it, and start a fresh copy of
 * production's data. Used when staging is created and on every sync.
 * removeStagingDatabases: deletes only the copies recorded here.
 * recordStagingDbCopy: the copy job's callback; restarts staging when done.
 *
 * Decisions live in lib/staging-db-plan.ts (tested). Production is only read.
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { getDb } from "@/lib/db";
import { coolifyFetch, coolifyMutateWithResponse } from "@/lib/coolify";
import { openJobLog } from "@/lib/job-log";
import {
  buildStagingDbCopyScript,
  buildStagingDbCreateRequest,
  findLinkedDatabases,
  findSharedDataServices,
  planStagingEnvRewrite,
  stagingDbEngine,
  type PlatformDatabase,
  type StagingDbMapping
} from "@/lib/staging-db-plan";

export type StagingDatabaseRow = {
  id: string;
  siteId: string;
  productionDbUuid: string;
  productionDbName: string;
  stagingDbUuid: string | null;
  engine: string;
  status: string;
  lastCopiedAt: Date | null;
  lastError: string | null;
  tableCount: number | null;
  updatedAt: Date;
};

export type EnsureResult = { ok: boolean; message: string; databases: number; copying: number; shared: string[] };

const COPY_STALE_MS = 2 * 60 * 60_000;

async function audit(db: any, organizationId: string, siteId: string, actionType: string, details: Record<string, unknown>) {
  try {
    await db.auditLog.create({
      data: { organizationId, actorId: null, action: "site_updated", resourceType: "site_staging", resourceId: siteId, details: { actionType, ...details } }
    });
  } catch (error) {
    console.error("[staging-db] audit write failed", error);
  }
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

function resolveScriptPath(name: string): string | null {
  const cwd = process.cwd();
  return [path.join(cwd, "scripts", name), path.join(cwd, "..", "scripts", name), path.join(cwd, "..", "..", "scripts", name)].find((candidate) =>
    existsSync(candidate)
  ) ?? null;
}

/** Starts the detached copy job for the given rows. Scripts hold no secrets. */
function startCopyJob(items: Array<{ id: string; script: string }>): boolean {
  const scriptPath = resolveScriptPath("staging-db-copy.mjs");
  if (!scriptPath || items.length === 0) return false;
  const dir = mkdtempSync(path.join(os.tmpdir(), "staging-db-"));
  const payload = path.join(dir, "payload.json");
  writeFileSync(payload, JSON.stringify(items), { encoding: "utf8", mode: 0o600 });
  const log = openJobLog("staging-db-copy");
  const child = spawn(process.execPath, [scriptPath, "--payload", payload], {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: ["ignore", log, log]
  });
  child.unref();
  return true;
}

async function liveRows(db: any, siteId: string): Promise<StagingDatabaseRow[]> {
  return db.stagingDatabase.findMany({ where: { siteId, status: { not: "removed" } }, orderBy: { createdAt: "asc" } });
}

/**
 * Creates any missing staging databases, rewires the staging app, and starts a
 * fresh copy of production into every staging database.
 */
export async function ensureStagingDatabases(siteId: string): Promise<EnsureResult> {
  const empty = (ok: boolean, message: string): EnsureResult => ({ ok, message, databases: 0, copying: 0, shared: [] });
  const db: any = await getDb();
  if (!db) return empty(false, "The database is unavailable.");
  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { id: true, organizationId: true, coolifyServiceUuid: true, coolifyProjectId: true, stagingTargetUuid: true }
  });
  const productionUuid = site?.coolifyServiceUuid?.trim();
  const stagingUuid = site?.stagingTargetUuid?.trim();
  if (!site || !productionUuid) return empty(false, "This app isn't linked to a running site yet.");
  if (!stagingUuid) return empty(false, "Staging hasn't been created for this app yet.");

  // Only apps: a WordPress staging service carries its own database already.
  let stagingApp: Record<string, unknown> | null = null;
  try {
    const payload = await coolifyFetch(`/api/v1/applications/${encodeURIComponent(stagingUuid)}`);
    stagingApp = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  } catch {
    stagingApp = null;
  }
  if (!stagingApp) return empty(true, "Staging has its own database already.");

  const [databasesRaw, productionEnvsRaw] = await Promise.all([
    coolifyFetch("/api/v1/databases").catch(() => null),
    coolifyFetch(`/api/v1/applications/${encodeURIComponent(productionUuid)}/envs`).catch(() => null)
  ]);
  if (!Array.isArray(databasesRaw) || !Array.isArray(productionEnvsRaw)) {
    return empty(false, "Couldn't read the app's databases just now. Use Try again.");
  }
  const databases = databasesRaw as PlatformDatabase[];
  const productionEnvs = productionEnvsRaw as Array<Record<string, unknown>>;

  const shared = findSharedDataServices(productionEnvs);
  await db.site.update({ where: { id: site.id }, data: { stagingSharedServices: shared.length ? shared.join(",") : null } });

  const existing = await liveRows(db, site.id);
  const busy = existing.find((row) => row.status === "copying" && Date.now() - new Date(row.updatedAt).getTime() < COPY_STALE_MS);
  if (busy) return { ok: false, message: "A copy of the production database is already running. It finishes on its own.", databases: existing.length, copying: 1, shared };

  const stagingIds = new Set(existing.map((row) => row.stagingDbUuid).filter(Boolean));
  // Never treat a staging copy as a production database to copy from.
  const linked = findLinkedDatabases(productionEnvs, databases).filter((prod) => !stagingIds.has(prod.uuid));
  if (linked.length === 0) {
    return { ok: true, message: shared.length ? `Staging shares ${shared.join(", ")} with production.` : "This app uses no platform database.", databases: 0, copying: 0, shared };
  }

  const environment = (stagingApp.environment && typeof stagingApp.environment === "object" ? stagingApp.environment : {}) as Record<string, unknown>;
  const placement = {
    projectUuid: site.coolifyProjectId?.trim() ?? "",
    environmentName: typeof environment.name === "string" ? environment.name : "",
    environmentUuid: typeof environment.uuid === "string" ? environment.uuid : ""
  };

  const mappings: StagingDbMapping[] = [];
  const copies: Array<{ id: string; script: string }> = [];
  const failures: string[] = [];

  for (const production of linked) {
    const engine = stagingDbEngine(production.database_type);
    let row = existing.find((candidate) => candidate.productionDbUuid === production.uuid) ?? null;
    let staging = row?.stagingDbUuid ? databases.find((candidate) => candidate.uuid === row!.stagingDbUuid) ?? null : null;

    if (!staging) {
      const request = buildStagingDbCreateRequest({ production, placement, name: `staging-${production.name}` });
      if (!request.ok || !engine) {
        failures.push(`${production.name}: ${request.ok ? "unsupported engine" : request.reason.replace(/_/g, " ")}`);
        continue;
      }
      const created = await coolifyMutateWithResponse(request.path, "POST", request.body);
      const body = (created.body ?? {}) as Record<string, unknown>;
      const uuid = typeof body.uuid === "string" ? body.uuid : "";
      if (!created.ok || !uuid) {
        failures.push(`${production.name}: the server refused to create it (HTTP ${created.status ?? "n/a"})`);
        if (row) await db.stagingDatabase.update({ where: { id: row.id }, data: { status: "failed", lastError: "Couldn't create the staging database." } });
        continue;
      }
      staging = { ...production, uuid, name: String(request.body.name), internal_db_url: typeof body.internal_db_url === "string" ? body.internal_db_url : null };
      row = row
        ? await db.stagingDatabase.update({ where: { id: row.id }, data: { stagingDbUuid: uuid, status: "creating", lastError: null } })
        : await db.stagingDatabase.create({
            data: { siteId: site.id, productionDbUuid: production.uuid, productionDbName: production.name, stagingDbUuid: uuid, engine, status: "creating" }
          });
      await audit(db, site.organizationId, site.id, "staging_database_created", { production: production.name, stagingDbUuid: uuid, engine });
    }

    if (!staging.internal_db_url) {
      try {
        const detail = (await coolifyFetch(`/api/v1/databases/${encodeURIComponent(staging.uuid)}`)) as Record<string, unknown>;
        staging = { ...staging, internal_db_url: typeof detail?.internal_db_url === "string" ? detail.internal_db_url : null };
      } catch {
        // Handled below: without its URL the app can't be pointed at it.
      }
    }
    if (!production.internal_db_url || !staging.internal_db_url) {
      failures.push(`${production.name}: its connection address isn't available yet`);
      await db.stagingDatabase.update({ where: { id: row!.id }, data: { status: "failed", lastError: "The staging database's address isn't available yet." } });
      continue;
    }
    mappings.push({ fromUuid: production.uuid, toUuid: staging.uuid, fromUrl: production.internal_db_url, toUrl: staging.internal_db_url });
    copies.push({ id: row!.id, script: buildStagingDbCopyScript({ engine: engine!, source: production.uuid, target: staging.uuid }) });
  }

  // Point the staging app at its own databases before any copy can finish.
  if (mappings.length) {
    const stagingEnvs = await coolifyFetch(`/api/v1/applications/${encodeURIComponent(stagingUuid)}/envs`).catch(() => null);
    const writes = planStagingEnvRewrite(asArray(stagingEnvs), mappings);
    if (writes.length) {
      const patched = await coolifyMutateWithResponse(`/api/v1/applications/${encodeURIComponent(stagingUuid)}/envs/bulk`, "PATCH", { data: writes });
      if (!patched.ok) {
        // Never let staging keep production's database: no copy, report it.
        for (const copy of copies) {
          await db.stagingDatabase.update({ where: { id: copy.id }, data: { status: "failed", lastError: "Couldn't point staging at its own database." } });
        }
        return { ok: false, message: "Staging's database was created, but staging couldn't be pointed at it yet. Use Try again.", databases: linked.length, copying: 0, shared };
      }
    }
  }

  if (copies.length) {
    await db.stagingDatabase.updateMany({ where: { id: { in: copies.map((copy) => copy.id) } }, data: { status: "copying", lastError: null } });
    if (!startCopyJob(copies)) {
      await db.stagingDatabase.updateMany({ where: { id: { in: copies.map((copy) => copy.id) } }, data: { status: "failed", lastError: "The copy job couldn't start." } });
      return { ok: false, message: "The copy of production's data couldn't start. Use Try again.", databases: linked.length, copying: 0, shared };
    }
  }

  const parts = [];
  if (copies.length) parts.push(`Copying production's database into staging's own (${copies.length}). Staging restarts when it's done.`);
  if (failures.length) parts.push(`Not ready: ${failures.join("; ")}.`);
  if (shared.length) parts.push(`Staging still shares ${shared.join(", ")} with production.`);
  return { ok: failures.length === 0, message: parts.join(" ") || "Staging's databases are up to date.", databases: linked.length, copying: copies.length, shared };
}

/** The copy job's callback. Restarts staging once nothing is still copying. */
export async function recordStagingDbCopy(input: { stagingDatabaseId: string; result: string; error?: string | null; tables?: number | null }): Promise<{ ok: boolean; status: number }> {
  const db: any = await getDb();
  if (!db) return { ok: false, status: 503 };
  const row = await db.stagingDatabase.findUnique({ where: { id: input.stagingDatabaseId } });
  if (!row || row.status === "removed") return { ok: false, status: 404 };
  const succeeded = input.result === "ok" || input.result === "skipped";
  await db.stagingDatabase.update({
    where: { id: row.id },
    data: succeeded
      ? { status: "ready", lastCopiedAt: new Date(), lastError: null, tableCount: typeof input.tables === "number" ? input.tables : null }
      : { status: "failed", lastError: friendlyCopyError(input.error) }
  });
  const site = await db.site.findUnique({ where: { id: row.siteId }, select: { id: true, organizationId: true, stagingTargetUuid: true } });
  if (site) {
    await audit(db, site.organizationId, site.id, succeeded ? "staging_database_copied" : "staging_database_copy_failed", {
      production: row.productionDbName,
      stagingDbUuid: row.stagingDbUuid,
      tables: input.tables ?? null,
      error: succeeded ? null : input.error ?? null
    });
    const remaining = await db.stagingDatabase.count({ where: { siteId: site.id, status: "copying" } });
    if (remaining === 0 && succeeded && site.stagingTargetUuid) {
      await coolifyMutateWithResponse(`/api/v1/applications/${encodeURIComponent(site.stagingTargetUuid)}/restart`, "POST").catch(() => null);
    }
  }
  return { ok: true, status: 200 };
}

function friendlyCopyError(error?: string | null): string {
  const reason = String(error ?? "").split(" — ")[0];
  switch (reason) {
    case "target_not_ready":
      return "The staging database didn't start in time. Use Try again.";
    case "source_not_running":
      return "Production's database isn't running, so nothing was copied.";
    case "client_missing":
      return "The database tools needed for the copy aren't in the database image.";
    case "host_not_configured":
      return "Jongo can't reach the database server yet (SSH host not configured).";
    default:
      return `Copying production's data failed${reason ? ` (${reason.replace(/_/g, " ")})` : ""}. Use Try again.`;
  }
}

/** Deletes the staging databases recorded for this site, and only those. */
export async function removeStagingDatabases(siteId: string): Promise<{ removed: number; failed: number }> {
  const db: any = await getDb();
  const result = { removed: 0, failed: 0 };
  if (!db) return result;
  const rows = await liveRows(db, siteId);
  const productionUuids = new Set(rows.map((row) => row.productionDbUuid));
  for (const row of rows) {
    const uuid = row.stagingDbUuid?.trim();
    // A recorded staging uuid can never be a production database.
    if (uuid && !productionUuids.has(uuid)) {
      const deleted = await coolifyMutateWithResponse(`/api/v1/databases/${encodeURIComponent(uuid)}?delete_volumes=true`, "DELETE");
      if (!deleted.ok && deleted.status !== 404) {
        result.failed += 1;
        await db.stagingDatabase.update({ where: { id: row.id }, data: { lastError: "Couldn't delete the staging database yet." } });
        continue;
      }
    }
    await db.stagingDatabase.update({ where: { id: row.id }, data: { status: "removed", removedAt: new Date() } });
    result.removed += 1;
  }
  return result;
}

export type StagingDatabaseView = {
  databases: Array<{ id: string; name: string; engine: string; status: string; lastCopiedAt: string | null; lastError: string | null; tableCount: number | null }>;
  shared: string[];
};

export async function stagingDatabaseView(siteId: string): Promise<StagingDatabaseView> {
  const db: any = await getDb();
  if (!db || !/^[0-9a-f-]{36}$/i.test(siteId)) return { databases: [], shared: [] };
  const [rows, site] = await Promise.all([
    liveRows(db, siteId).catch(() => []),
    db.site.findUnique({ where: { id: siteId }, select: { stagingSharedServices: true } }).catch(() => null)
  ]);
  return {
    databases: rows.map((row) => ({
      id: row.id,
      name: row.productionDbName,
      engine: row.engine,
      status: row.status,
      lastCopiedAt: row.lastCopiedAt ? new Date(row.lastCopiedAt).toISOString() : null,
      lastError: row.lastError,
      tableCount: row.tableCount
    })),
    shared: String(site?.stagingSharedServices ?? "").split(",").map((name) => name.trim()).filter(Boolean)
  };
}
