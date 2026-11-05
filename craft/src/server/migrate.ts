import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CraftError, fail } from './errors.js';
import type { Queryable, SqlExecutor } from './executor.js';
import { sha256Hex } from './json.js';

/** Absolute path of the SQL files shipped in this package (resolved next to the installed dist folder). */
export const migrationsDir: string = fileURLToPath(new URL('../../migrations/', import.meta.url));

export type Migration = { name: string; sql: string; checksum: string };
export type MigrationReport = { applied: string[]; alreadyApplied: string[] };

const FILE = /^\d{4}_[a-z0-9_]+\.sql$/;
/** Line endings are normalized so a Windows checkout and a Linux checkout hash alike. */
export const migrationChecksum = (sql: string): string => sha256Hex(sql.replace(/\r\n?/g, '\n'));

export async function loadMigrations(dir: string = migrationsDir): Promise<Migration[]> {
  let names: string[];
  try { names = (await readdir(dir)).filter(name => name.endsWith('.sql')).sort(); } catch { return fail('migration_invalid'); }
  const out: Migration[] = [];
  for (const name of names) {
    if (!FILE.test(name)) return fail('migration_invalid', { migration: name });
    const sql = await readFile(join(dir, name), 'utf8');
    if (!sql.trim()) return fail('migration_invalid', { migration: name });
    out.push({ name, sql, checksum: migrationChecksum(sql) });
  }
  return out;
}

const LOCK = `SELECT pg_advisory_xact_lock(hashtextextended('craft:migrations', 0))`;

async function verify(q: Queryable, byName: Map<string, Migration>) {
  const applied = await q.query<{ name: string; checksum: string }>('SELECT name, checksum FROM craft.schema_migrations ORDER BY name');
  for (const row of applied.rows) {
    const known = byName.get(row.name);
    if (!known) return fail('migration_missing', { migration: row.name });
    if (known.checksum !== row.checksum) return fail('migration_checksum_mismatch', { migration: row.name });
  }
  return new Set(applied.rows.map(row => row.name));
}

/**
 * Applies pending migrations in file order. Safe to call on every deploy start, from several processes at once.
 * Each step is its own transaction that first takes a transaction-scoped advisory lock (pg_advisory_xact_lock, so it
 * cannot leak across pooled connections) and re-reads state, which makes concurrent runners serialize and skip work
 * already done. Refuses, changing nothing further, when an applied migration's checksum differs or its file is gone.
 */
export async function runMigrations(executor: SqlExecutor, options: { dir?: string; migrations?: readonly Migration[] } = {}): Promise<MigrationReport> {
  const migrations = options.migrations ? [...options.migrations].sort((a, b) => a.name.localeCompare(b.name)) : await loadMigrations(options.dir);
  const byName = new Map(migrations.map(m => [m.name, m]));
  if (byName.size !== migrations.length) return fail('migration_invalid');
  const report: MigrationReport = { applied: [], alreadyApplied: [] };
  let current: string | undefined;
  try {
    const initial = await executor.transaction(async q => {
      await q.query(LOCK);
      await q.query('CREATE SCHEMA IF NOT EXISTS craft');
      await q.query(`CREATE TABLE IF NOT EXISTS craft.schema_migrations (
        name text PRIMARY KEY, checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'), applied_at timestamptz NOT NULL DEFAULT now())`);
      return verify(q, byName);
    });
    for (const migration of migrations) {
      if (initial.has(migration.name)) { report.alreadyApplied.push(migration.name); continue; }
      current = migration.name;
      const done = await executor.transaction(async q => {
        await q.query(LOCK);
        const existing = await q.query<{ checksum: string }>('SELECT checksum FROM craft.schema_migrations WHERE name = $1', [migration.name]);
        if (existing.rows[0]) {
          if (existing.rows[0].checksum !== migration.checksum) return fail('migration_checksum_mismatch', { migration: migration.name });
          return false;
        }
        await q.query(migration.sql);
        await q.query('INSERT INTO craft.schema_migrations (name, checksum) VALUES ($1, $2)', [migration.name, migration.checksum]);
        return true;
      });
      (done ? report.applied : report.alreadyApplied).push(migration.name);
    }
  } catch (error) {
    if (error instanceof CraftError) throw error;
    // The driver error is dropped on purpose: it can quote SQL and data.
    throw new CraftError('migration_failed', current ? { migration: current } : {});
  }
  return report;
}
