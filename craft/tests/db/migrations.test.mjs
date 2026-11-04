import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { createPgExecutor, loadMigrations, migrationsDir, runMigrations } from '../../dist/server/index.js';
import { expectError, freshDb, poolFor } from './helpers.mjs';

const temps = [];
after(async () => { for (const dir of temps) await rm(dir, { recursive: true, force: true }); });
const copyMigrations = async () => { const dir = await mkdtemp(join(tmpdir(), 'craft-mig-')); temps.push(dir); await cp(migrationsDir, dir, { recursive: true }); return dir; };

test('migrations apply on a fresh database and record checksums', async () => {
  const db = await freshDb('mig1', { migrate: false });
  try {
    const report = await runMigrations(db.executor);
    assert.deepEqual(report.applied, ['0001_init.sql']);
    assert.deepEqual(report.alreadyApplied, []);
    const tables = (await db.sql(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'craft' ORDER BY 1`)).rows.map(r => r.table_name);
    assert.deepEqual(tables, ['audit_log', 'datasets', 'documents', 'mutations', 'references', 'revisions', 'schema_migrations']);
    const rows = (await db.sql('SELECT name, checksum FROM craft.schema_migrations')).rows;
    const [migration] = await loadMigrations();
    assert.deepEqual(rows, [{ name: migration.name, checksum: migration.checksum }]);
    // Nothing escapes the dedicated schema.
    const outside = await db.sql(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`);
    assert.equal(outside.rows[0].n, 0);
  } finally { await db.close(); }
});

test('running migrations again is idempotent', async () => {
  const db = await freshDb('mig2');
  try {
    const again = await runMigrations(db.executor);
    assert.deepEqual(again, { applied: [], alreadyApplied: ['0001_init.sql'] });
    assert.equal((await db.sql('SELECT count(*)::int AS n FROM craft.schema_migrations')).rows[0].n, 1);
  } finally { await db.close(); }
});

test('concurrent runners from separate connection pools apply exactly once without error', async () => {
  const db = await freshDb('mig3', { migrate: false });
  try {
    const other = db.track(poolFor(db.database));
    const results = await Promise.all([runMigrations(db.executor), runMigrations(createPgExecutor(other)), runMigrations(db.executor), runMigrations(createPgExecutor(other))]);
    assert.equal(results.flatMap(r => r.applied).length, 1, 'one runner applied it');
    assert.equal(results.filter(r => r.alreadyApplied.length === 1).length, 3);
    assert.equal((await db.sql('SELECT count(*)::int AS n FROM craft.schema_migrations')).rows[0].n, 1);
  } finally { await db.close(); }
});

test('a held advisory lock makes the runner wait, then proceed', async () => {
  const db = await freshDb('mig4', { migrate: false });
  try {
    const holder = await db.pool.connect();
    await holder.query('BEGIN');
    await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended('craft:migrations', 0))`);
    let finished = false;
    const pending = runMigrations(db.executor).then(r => { finished = true; return r; });
    await new Promise(r => setTimeout(r, 400));
    assert.equal(finished, false, 'blocked while the lock is held');
    const waiting = await db.sql(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`);
    assert.ok(waiting.rows[0].n >= 1);
    await holder.query('COMMIT'); holder.release();
    assert.deepEqual((await pending).applied, ['0001_init.sql']);
  } finally { await db.close(); }
});

test('refuses when an applied migration file changed (checksum tamper) and when it is missing', async () => {
  const db = await freshDb('mig5');
  try {
    const dir = await copyMigrations();
    await writeFile(join(dir, '0001_init.sql'), `${await readFile(join(dir, '0001_init.sql'), 'utf8')}\n-- tampered\n`);
    const error = await expectError(runMigrations(db.executor, { dir }), 'migration_checksum_mismatch');
    assert.equal(error.migration, '0001_init.sql');
    // DB-side tamper too.
    await db.sql(`UPDATE craft.schema_migrations SET checksum = repeat('0', 64)`);
    await expectError(runMigrations(db.executor), 'migration_checksum_mismatch');
    // A database ahead of this package (applied migration absent from the files).
    const empty = await mkdtemp(join(tmpdir(), 'craft-mig-empty-')); temps.push(empty);
    await expectError(runMigrations(db.executor, { dir: empty }), 'migration_missing');
  } finally { await db.close(); }
});

test('line-ending changes alone do not change a checksum', async () => {
  const db = await freshDb('mig6');
  try {
    const dir = await copyMigrations();
    const text = await readFile(join(dir, '0001_init.sql'), 'utf8');
    await writeFile(join(dir, '0001_init.sql'), text.replace(/\r?\n/g, '\r\n'));
    assert.deepEqual((await runMigrations(db.executor, { dir })).alreadyApplied, ['0001_init.sql']);
  } finally { await db.close(); }
});

test('a failing migration rolls back completely, is not recorded, and reports only a fixed message', async () => {
  const db = await freshDb('mig7', { migrate: false });
  try {
    const migrations = [{ name: '0001_bad.sql', checksum: 'a'.repeat(64), sql: `CREATE TABLE craft.half (x int); SELECT 1/0 AS secret_marker;` }];
    const error = await expectError(runMigrations(db.executor, { migrations }), 'migration_failed');
    assert.equal(error.migration, '0001_bad.sql');
    assert.ok(!/division|secret_marker|CREATE TABLE/i.test(error.message));
    assert.equal((await db.sql(`SELECT to_regclass('craft.half') AS t`)).rows[0].t, null);
    assert.equal((await db.sql('SELECT count(*)::int AS n FROM craft.schema_migrations')).rows[0].n, 0);
    // The real migrations still apply afterwards.
    assert.deepEqual((await runMigrations(db.executor)).applied, ['0001_init.sql']);
  } finally { await db.close(); }
});

test('invalid migration file names are rejected before touching the database', async () => {
  const db = await freshDb('mig8', { migrate: false });
  try {
    const dir = await mkdtemp(join(tmpdir(), 'craft-mig-bad-')); temps.push(dir);
    await writeFile(join(dir, 'init.sql'), 'SELECT 1');
    await expectError(runMigrations(db.executor, { dir }), 'migration_invalid');
    assert.equal((await db.sql(`SELECT to_regnamespace('craft') AS s`)).rows[0].s, null);
  } finally { await db.close(); }
});
