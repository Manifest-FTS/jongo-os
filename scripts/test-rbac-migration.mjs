/**
 * TSK-01088: node scripts/test-rbac-migration.mjs
 * Requires installed Prisma dependencies and PostgreSQL 17 binaries (PG_BIN may
 * override their directory). Never loads .env or connects to an existing DB.
 * --fail-after-start deliberately tests the failure/cleanup path.
 *
 * Recorded validation (2026-10-16, Windows PostgreSQL 17, Node 24.14.1,
 * Prisma 5.22.0, BEFORE HEAD a5e0172a04120b9c646faffd2982a07d650ebf3f):
 * - All 10 SQL checks passed on 55488 and again on fallback port 62894.
 * - Fallback run occupied 55488 with a disposable test listener and supplied
 *   invalid inherited DATABASE_URL/PGHOST/PGSERVICE; these were ignored.
 * - --fail-after-start exited 1 as expected and cleaned up successfully.
 * - Successful runs stopped their clusters and removed temporary directories.
 * - Generated Prisma client behavior is NOT covered; create/upsert is SQL.
 * Only this harness was added; no application/package/schema/migration edits,
 * existing service changes, live/prod DB access, or commits were performed.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer, createConnection } from 'node:net';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const bin = process.env.PG_BIN || (process.platform === 'win32'
  ? 'C:/Program Files/PostgreSQL/17/bin' : '/usr/lib/postgresql/17/bin');
const pg = (name) => join(bin, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
// Allowlist, not a copy of process.env: no inherited DB URLs, PG service files,
// Prisma overrides, NODE_OPTIONS, provider credentials, or application secrets.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(path|systemroot|windir|comspec|pathext|temp|tmp|home|userprofile|localappdata|appdata|lang|lc_all)$/i.test(key)));
let temp;
let data;
let port;
let startAttempted = false;
let cleaned = false;
let checks = 0;

async function run(command, args, cwd = temp) {
  try {
    const options = { cwd, env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 };
    if (command === pg('pg_ctl')) {
      // Windows postgres can inherit pg_ctl's pipes, preventing execFile's
      // callback even after pg_ctl exits. Close only those pipes on its exit.
      return await new Promise((accept, reject) => {
        const child = execFile(command, args, options, (error, stdout) => error ? reject(error) : accept(stdout));
        child.once('exit', () => {
          child.stdin?.destroy();
          child.stdout?.destroy();
          child.stderr?.destroy();
        });
      });
    }
    return (await exec(command, args, options)).stdout;
  } catch (error) {
    // Do not print execFile's command/env object or inherited configuration.
    throw new Error(`${command === process.execPath ? 'Prisma' : command.split(/[\\/]/).at(-1)} failed: ${error.stderr?.trim() || error.code || 'unknown error'}`);
  }
}

async function freePort(preferred = 55488) {
  const server = createServer();
  try {
    await new Promise((accept, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: preferred, exclusive: true }, accept);
    });
    const selected = server.address().port;
    await new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept()));
    return selected;
  } catch (error) {
    if (preferred && error.code === 'EADDRINUSE') return freePort(0);
    throw error;
  }
}

async function portIsOpen() {
  return new Promise((accept) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); accept(true); });
    socket.once('error', () => accept(false));
    socket.once('timeout', () => { socket.destroy(); accept(true); });
  });
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function cleanup() {
  if (cleaned || !temp) return;
  // Never stop by service name, port, or process search: only our mkdtemp data dir.
  if (startAttempted && await exists(join(data, 'postmaster.pid'))) {
    await run(pg('pg_ctl'), ['-D', data, '-m', 'fast', '-w', '-t', '30', 'stop']);
    assert.equal(await exists(join(data, 'postmaster.pid')), false, 'cluster PID removed');
    assert.equal(await portIsOpen(), false, 'temporary listener stopped');
  }
  await rm(temp, { recursive: true, force: true, maxRetries: 3 });
  cleaned = true;
  console.log('PASS cleanup: temporary cluster stopped and directory removed');
}

const psqlArgs = () => ['-X', '-w', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
async function sql(statement) {
  return (await run(pg('psql'), [...psqlArgs(), '-qAt', '-c', statement])).trim();
}
async function fileSql(path) {
  await run(pg('psql'), [...psqlArgs(), '--single-transaction', '-f', path]);
}
async function query(statement) { return JSON.parse(await sql(statement)); }
async function check(name, action) {
  await action();
  checks += 1;
  console.log(`PASS ${checks}: ${name}`);
}

try {
  for (const name of ['initdb', 'pg_ctl', 'psql']) await access(pg(name));
  const prismaCli = require.resolve('prisma/build/index.js');
  temp = await mkdtemp(join(tmpdir(), 'jongo-rbac-migration-'));
  data = join(temp, 'data');
  port = await freePort();
  Object.assign(env, {
    DATABASE_URL: `postgresql://postgres@127.0.0.1:${port}/postgres?schema=public`,
    DIRECT_URL: `postgresql://postgres@127.0.0.1:${port}/postgres?schema=public`,
    SHADOW_DATABASE_URL: `postgresql://postgres@127.0.0.1:${port}/postgres?schema=public`,
    PGCONNECT_TIMEOUT: '5', PGCLIENTENCODING: 'UTF8',
    PRISMA_HIDE_UPDATE_MESSAGE: '1', CHECKPOINT_DISABLE: '1'
  });

  // Pin the pre-task schema so this remains runnable after the task is committed.
  const baselineRef = process.env.RBAC_MIGRATION_BASE_REF || 'a5e0172a04120b9c646faffd2982a07d650ebf3f';
  const head = (await run('git', ['rev-parse', '--verify', baselineRef], root)).trim();
  const baseline = await run('git', ['show', `${head}:prisma/schema.prisma`], root);
  assert.doesNotMatch(baseline, /enum GlobalRole\s*\{/, 'baseline must be the BEFORE schema');
  const baselinePath = join(temp, 'baseline.prisma');
  const baselineSql = join(temp, 'baseline.sql');
  await writeFile(baselinePath, baseline);
  // Both cwd and schema are outside the repo, so Prisma cannot discover its .env.
  await writeFile(baselineSql, await run(process.execPath, [prismaCli, 'migrate', 'diff',
    '--from-empty', '--to-schema-datamodel', baselinePath, '--script']));

  await run(pg('initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '--encoding=UTF8', '--no-locale']);
  startAttempted = true;
  await run(pg('pg_ctl'), ['-D', data, '-l', join(temp, 'postgres.log'), '-w', '-t', '30',
    '-o', `-h 127.0.0.1 -p ${port}`, 'start']);
  const actualDirectory = await sql('SHOW data_directory');
  assert.equal(resolve(actualDirectory).toLowerCase(), resolve(data).toLowerCase(), 'connected to our cluster only');
  console.log(`Isolated PostgreSQL on 127.0.0.1:${port}; BEFORE schema HEAD ${head}`);
  if (process.argv.includes('--fail-after-start')) throw new Error('Intentional failure after cluster start (cleanup rehearsal)');
  await fileSql(baselineSql);

  const ids = {
    target: '10000000-0000-4000-8000-000000000001',
    deleted: '10000000-0000-4000-8000-000000000002',
    technical: '10000000-0000-4000-8000-000000000003',
    ordinary: '10000000-0000-4000-8000-000000000004',
    org: '20000000-0000-4000-8000-000000000001'
  };
  await sql(`
    INSERT INTO "User" (id, email, "updatedAt", "deletedAt") VALUES
      ('${ids.target}', '  DeVkEv@ManifestFTS.Com  ', '2020-01-01', NULL),
      ('${ids.deleted}', 'devkev@manifestfts.com', '2020-01-01', '2020-02-01'),
      ('${ids.technical}', 'technical@example.invalid', '2020-01-01', NULL),
      ('${ids.ordinary}', 'devkev@manifestfts.com.example.invalid', '2020-01-01', NULL);
    INSERT INTO "PlatformAdmin" ("userId", "grantedBy") VALUES ('${ids.technical}', '${ids.target}');
    INSERT INTO "Organization" (id, slug, name, "ownerId", "updatedAt")
      VALUES ('${ids.org}', 'fixture', 'Migration fixture', '${ids.ordinary}', '2020-01-01');
    INSERT INTO "Site" ("organizationId", slug, name, "updatedAt")
      VALUES ('${ids.org}', 'fixture-site', 'Fixture site', '2020-01-01');
    INSERT INTO "Domain" ("organizationId", name, "cloudflareZoneId", "registrarDomainId", nameservers, "updatedAt") VALUES
      ('${ids.org}', 'zone.example.invalid', 'fixture-zone', 'registrar-zone', ARRAY['ns1.example.invalid'], '2020-01-01'),
      ('${ids.org}', 'register.example.invalid', NULL, 'registrar-register', ARRAY['ns1.example.invalid'], '2020-01-01'),
      ('${ids.org}', 'transfer.example.invalid', NULL, 'registrar-transfer', ARRAY['ns1.example.invalid'], '2020-01-01'),
      ('${ids.org}', 'renew.example.invalid', NULL, 'registrar-renew', ARRAY['ns1.example.invalid'], '2020-01-01'),
      ('${ids.org}', 'import.example.invalid', NULL, 'registrar-import', ARRAY['ns1.example.invalid'], '2020-01-01');
    INSERT INTO "DomainCharge" ("domainId", operation, years, "wholesaleCents", "markupPercent", "markupCents", "clientCents", "updatedAt")
      SELECT id, split_part(name, '.', 1), 1, 1000, 20, 200, 1200, '2020-01-01'
      FROM "Domain" WHERE name IN ('register.example.invalid', 'transfer.example.invalid', 'renew.example.invalid');
  `);
  const originalDomains = await query(`SELECT json_agg(d ORDER BY id) FROM "Domain" d`);
  const originalCharges = await query(`SELECT json_agg(c ORDER BY id) FROM "DomainCharge" c`);
  const originalGrants = await query(`SELECT json_agg(g ORDER BY id) FROM "PlatformAdmin" g`);
  const migration = join(root, 'prisma/migrations/20261016090000_super_admin_client_billing/migration.sql');
  await fileSql(migration);

  await check('only the active, trimmed mixed-case target is promoted; no identities created', async () => {
    const users = await query(`SELECT json_agg(json_build_object('id', id, 'role', role, 'changed', "updatedAt" > '2020-01-01') ORDER BY id) FROM "User"`);
    assert.deepEqual(users, Object.values(ids).slice(0, 4).map((id) => ({
      id, role: id === ids.target ? 'super_admin' : 'collaborator', changed: id === ids.target
    })));
  });
  await check('technical grants survive unchanged, stay revocable and never copy a global role', async () => {
    assert.deepEqual(await query(`SELECT json_agg(g ORDER BY id) FROM "PlatformAdmin" g`), originalGrants);
    await sql(`DELETE FROM "PlatformAdmin" WHERE "userId" = '${ids.technical}'`);
    assert.equal(await sql(`SELECT count(*) FROM "PlatformAdmin"`), '0');
    assert.equal(await sql(`SELECT role FROM "User" WHERE id = '${ids.technical}'`), 'collaborator');
  });
  await check('existing client billing defaults are safe and optional references are null', async () => {
    assert.deepEqual(await query(`SELECT json_build_array("billingMode", "billingStatus", "billingNotes", "bonsaiClientId", "externalInvoiceUrl") FROM "Organization"`),
      ['manual_override', 'pending_setup', null, null, null]);
  });
  await check('existing domains keep inventory and receive all new billing/registrar defaults', async () => {
    const domains = await query(`SELECT json_agg(d ORDER BY id) FROM "Domain" d`);
    for (const domain of domains) {
      assert.deepEqual([domain.autoRenew, domain.isBillable, domain.billingOverride, domain.registrarSyncedAt], [false, true, false, null]);
      const { autoRenew, isBillable, billingOverride, registrarSyncedAt, dnsManagementEnabled, ...before } = domain;
      assert.deepEqual(before, originalDomains.find((row) => row.id === domain.id));
    }
    assert.equal(domains.length, originalDomains.length);
    assert.deepEqual(await query(`SELECT json_agg(c ORDER BY id) FROM "DomainCharge" c`), originalCharges);
  });
  await check('zone, register and transfer enroll DNS; renewal-only and plain imports do not', async () => {
    assert.deepEqual(await query(`SELECT json_object_agg(name, "dnsManagementEnabled") FROM "Domain"`), {
      'zone.example.invalid': true, 'register.example.invalid': true, 'transfer.example.invalid': true,
      'renew.example.invalid': false, 'import.example.invalid': false
    });
  });
  await check('new users, clients and unassigned domains receive database defaults', async () => {
    assert.equal(await sql(`INSERT INTO "User" (email, "updatedAt") VALUES ('new@example.invalid', NOW()) RETURNING role`), 'collaborator');
    assert.equal(await sql(`INSERT INTO "Organization" (slug, name, "ownerId", "updatedAt") VALUES ('new', 'New', '${ids.ordinary}', NOW()) RETURNING "billingMode" || '/' || "billingStatus"`), 'manual_override/pending_setup');
    assert.deepEqual(await query(`WITH d AS (INSERT INTO "Domain" (name, "updatedAt") VALUES ('unassigned.example.invalid', NOW()) RETURNING *)
      SELECT json_build_array("organizationId", "autoRenew", "isBillable", "billingOverride", "registrarSyncedAt", "dnsManagementEnabled") FROM d`),
      [null, false, true, false, null, false]);
  });
  await check('domain organization FK rejects missing clients', async () => {
    await sql(`DO $$ BEGIN
      BEGIN
        UPDATE "Domain" SET "organizationId" = 'ffffffff-ffff-4fff-8fff-ffffffffffff' WHERE name = 'unassigned.example.invalid';
        RAISE EXCEPTION 'Expected foreign_key_violation';
      EXCEPTION WHEN foreign_key_violation THEN NULL;
      END;
    END $$;`);
  });
  await check('domain inventory can be assigned, upserted and unassigned with SQL', async () => {
    await sql(`INSERT INTO "Domain" (name, "organizationId", "updatedAt") VALUES ('unassigned.example.invalid', '${ids.org}', NOW())
      ON CONFLICT (name) DO UPDATE SET "organizationId" = EXCLUDED."organizationId";`);
    assert.equal(await sql(`SELECT "organizationId" FROM "Domain" WHERE name = 'unassigned.example.invalid'`), ids.org);
    await sql(`UPDATE "Domain" SET "organizationId" = NULL WHERE name = 'unassigned.example.invalid'`);
    assert.equal(await sql(`SELECT "organizationId" IS NULL FROM "Domain" WHERE name = 'unassigned.example.invalid'`), 't');
  });
  await check('client deletion cascades its site but sets domain FK null, preserving inventory and charges', async () => {
    await sql(`DELETE FROM "Organization" WHERE id = '${ids.org}'`);
    assert.equal(await sql('SELECT count(*) FROM "Site"'), '0');
    assert.equal(await sql('SELECT count(*) FROM "Domain" WHERE "organizationId" IS NOT NULL'), '0');
    assert.equal(await sql('SELECT count(*) FROM "Domain"'), '6');
    const domains = await query(`SELECT json_agg(d ORDER BY id) FROM "Domain" d WHERE name <> 'unassigned.example.invalid'`);
    for (const old of originalDomains) {
      const current = domains.find((row) => row.id === old.id);
      for (const [key, value] of Object.entries(old)) assert.deepEqual(current[key], key === 'organizationId' ? null : value);
    }
    assert.deepEqual(await query(`SELECT json_agg(c ORDER BY id) FROM "DomainCharge" c`), originalCharges);
  });
  await check('a baseline with no target account never creates a passwordless super admin', async () => {
    await sql('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await fileSql(baselineSql);
    await sql(`INSERT INTO "User" (email, "updatedAt") VALUES ('only@example.invalid', NOW())`);
    await fileSql(migration);
    assert.equal(await sql('SELECT count(*) FROM "User"'), '1');
    assert.equal(await sql(`SELECT count(*) FROM "User" WHERE role <> 'collaborator'`), '0');
  });
  console.log(`PASS all ${checks} migration integration checks (SQL; no generated Prisma client exercised)`);
} catch (error) {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
} finally {
  try { await cleanup(); } catch (error) {
    console.error(`FAIL cleanup: ${error.message}; temporary directory retained: ${temp}`);
    process.exitCode = 1;
  }
}