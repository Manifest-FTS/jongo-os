/**
 * Run: node scripts/test-cms-migration.mjs
 * Requires installed Prisma dependencies and PostgreSQL 17 (PG_BIN overrides
 * the binary directory). No installs, dotenv, application imports or existing DB.
 * The baseline is pinned to the Git HEAD before CMS, not the working schema.
 * CMS_MIGRATION_BASE_REF can select another committed PRE-CMS schema; fails closed
 * if it already contains CMS. Historical migrations are not replayed: Prisma
 * diff materializes that baseline, then the actual CMS migration SQL is applied.
 * --fail-after-start rehearses failure cleanup. All fixtures are disposable.
 * SQL integrity + separate-session row-lock/CAS protocol checks only. These
 * handwritten SQL checks are NOT service/request tests: no authorization,
 * Prisma retry/SQL parity, source-checksum or publication/outbox proof.
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const bin = process.env.PG_BIN || (process.platform === 'win32'
  ? 'C:/Program Files/PostgreSQL/17/bin' : '/usr/lib/postgresql/17/bin');
const pg = (name) => join(bin, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
// Intentionally NOT {...process.env}: ignore DB URLs, PG services/passwords,
// Prisma overrides, NODE_OPTIONS, dotenv settings and all application secrets.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(path|systemroot|windir|comspec|pathext|temp|tmp|home|userprofile|localappdata|appdata|lang|lc_all)$/i.test(key)));
const password = randomBytes(32).toString('hex');
let temp;
let data;
let port;
let startAttempted = false;
let cleanupPromise;
let checks = 0;
const sessions = new Set();

async function run(command, args, cwd = temp) {
  return new Promise((accept, reject) => {
    const child = execFile(command, args, {
      cwd, env, windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (!error) return accept(stdout);
      // Never serialize execFile's args/env (which may include the test password).
      const detail = String(stderr || error.code || 'unknown error').replaceAll(password, '[redacted]').trim();
      reject(new Error(`${command === process.execPath ? 'Prisma' : command.split(/[\\/]/).at(-1)} failed: ${detail}`));
    });
    if (command === pg('pg_ctl')) {
      // Windows postgres inherits pg_ctl pipes: release them on the controller's
      // exit, not on stream EOF, or execFile's callback can wait indefinitely.
      child.once('exit', () => {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
      });
    }
  });
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}
async function freePort() {
  const server = createServer();
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, accept);
  });
  const selected = server.address().port;
  await new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept()));
  return selected;
}
async function portIsOpen() {
  return new Promise((accept) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); accept(true); });
    socket.once('error', () => { socket.destroy(); accept(false); });
    socket.once('timeout', () => { socket.destroy(); accept(true); });
  });
}
async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    if (!temp) return;
    // End interactive clients first, rolling back any still-open transactions.
    await Promise.all([...sessions].map((session) => session.close()));
    // Stop only our own mkdtemp data directory, never a service/port/process scan.
    if (startAttempted && await exists(join(data, 'postmaster.pid'))) {
      await run(pg('pg_ctl'), ['-D', data, '-m', 'fast', '-w', '-t', '30', 'stop']);
      assert.equal(await exists(join(data, 'postmaster.pid')), false, 'own PID removed');
      assert.equal(await portIsOpen(), false, 'temporary listener stopped');
    }
    await rm(temp, { recursive: true, force: true, maxRetries: 3 });
    assert.equal(await exists(temp), false, 'temporary directory removed');
    console.log('PASS cleanup: temporary cluster stopped and directory removed');
  })();
  return cleanupPromise;
}

const psqlArgs = () => ['-X', '-w', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
async function sql(statement) {
  return (await run(pg('psql'), [...psqlArgs(), '-qAt', '-c', statement])).trim();
}
async function fileSql(path) {
  // The CMS file owns its BEGIN/COMMIT; do not wrap it in another transaction.
  await run(pg('psql'), [...psqlArgs(), '-f', path]);
}

// Persistent stdin keeps BEGIN alive across awaits. Output markers are event
// barriers, not sleeps/polling; only one outstanding command per session.
function sqlSession() {
  const child = spawn(pg('psql'), [...psqlArgs(), '-qAt'], { cwd: temp, env, windowsHide: true });
  let pending;
  let output = '';
  let stderr = '';
  let ended = false;
  let spawnError;
  const detail = () => String(stderr || spawnError?.code || 'session closed').replaceAll(password, '[redacted]').trim();
  const done = new Promise((accept) => {
    child.once('close', (code) => {
      ended = true;
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`psql session failed (${code}): ${detail()}`));
        pending = undefined;
      }
      sessions.delete(session);
      accept();
    });
  });
  child.once('error', (error) => { spawnError = error; });
  child.stdin.on('error', (error) => { spawnError = error; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    output += chunk;
    if (!pending) return;
    const lines = output.replaceAll('\r', '').split('\n');
    const index = lines.indexOf(pending.marker);
    if (index === -1) return;
    const current = pending;
    pending = undefined;
    output = lines.slice(index + 1).join('\n');
    clearTimeout(current.timer);
    current.accept(lines.slice(0, index).join('\n').trim());
  });
  const session = {
    execute(statement) {
      assert.equal(pending, undefined, 'one command at a time per psql session');
      assert.equal(ended, false, 'psql session is open');
      return new Promise((accept, reject) => {
        const marker = `cms_barrier_${randomBytes(16).toString('hex')}`;
        const timer = setTimeout(() => {
          pending = undefined;
          child.kill();
          reject(new Error('psql session command exceeded 15s safety deadline'));
        }, 15_000);
        pending = { accept, reject, marker, timer };
        child.stdin.write(`${statement}\n\\echo ${marker}\n`);
      });
    },
    async close() {
      if (!ended) {
        if (pending) child.kill();
        else child.stdin.end('\\q\n');
      }
      await done;
    }
  };
  sessions.add(session);
  return session;
}

// Mirrors documents.ts lockPolicy's fixed scoped order, NOT its authorization.
const policyLocks = () => `
  SELECT id FROM "CmsDataset" WHERE id='${dsA}' FOR UPDATE;
  SELECT id FROM "Organization" WHERE id='${orgA}' FOR SHARE;
  SELECT id FROM "User" WHERE id IN ('${editor}','${owner}') ORDER BY id FOR SHARE;
  SELECT id FROM "Collaborator" WHERE "organizationId"='${orgA}' AND "userId"='${editor}' ORDER BY id FOR SHARE;
  SELECT id FROM "CmsDatasetGrant" WHERE "datasetId"='${dsA}' AND "userId"='${editor}' ORDER BY id FOR SHARE;
  SELECT id FROM "Site" WHERE id='${siteA}' FOR SHARE;
  SELECT id FROM "SiteCollaborator" WHERE "siteId"='${siteA}' AND "userId"='${editor}' ORDER BY id FOR SHARE;`;

const expectLockTimeout = (statement) => `DO $lock_test$ BEGIN
  BEGIN
    ${statement};
    RAISE EXCEPTION 'Expected lock_timeout SQLSTATE 55P03';
  EXCEPTION WHEN SQLSTATE '55P03' THEN
    RAISE NOTICE 'expected lock_timeout';
  END;
END $lock_test$;`;

async function check(name, action) {
  await action();
  console.log(`PASS ${++checks}: ${name}`);
}
async function rejected(statement, state, constraint, message) {
  // Catch only the exact expected SQLSTATE. Unexpected success raises P0001.
  // Constraint/message checks prevent an unrelated FK/trigger masking a defect.
  await sql(`DO $test$ DECLARE actual_constraint text; actual_message text; BEGIN
    BEGIN
      ${statement};
      RAISE EXCEPTION 'Expected SQLSTATE ${state}';
    EXCEPTION WHEN SQLSTATE '${state}' THEN
      GET STACKED DIAGNOSTICS actual_constraint = CONSTRAINT_NAME, actual_message = MESSAGE_TEXT;
      ${constraint ? `IF actual_constraint <> '${constraint}' THEN RAISE EXCEPTION 'Wrong constraint: %', actual_constraint; END IF;` : ''}
      ${message ? `IF position('${message}' in actual_message) = 0 THEN RAISE EXCEPTION 'Wrong error: %', actual_message; END IF;` : ''}
    END;
  END $test$;`);
}

// UUID storage identities deliberately differ from source/native text IDs.
const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [owner, editor, orgA, orgB, siteA, siteB, dsA, dsB, draft, published, other, revA, revB, mutationA, mutationB] =
  Array.from({ length: 15 }, (_, i) => id(i + 1));
const hash = 'a'.repeat(64);
const documentSql = (uuid, dataset, native, logical, variant = 'draft') =>
  `INSERT INTO "CmsDocument" (id,"datasetId",native_id,type,"logicalId",variant,"updatedAt")
   VALUES ('${uuid}','${dataset}','${native}','article','${logical}','${variant}',NOW())`;
const mutationSql = (uuid, dataset, key) =>
  `INSERT INTO "CmsMutation" (id,"datasetId","actorId",key,operation,"requestSha256",result)
   VALUES ('${uuid}','${dataset}','${editor}','${key}','save','${hash}','{}')`;
const revisionSql = (uuid, dataset, document, sequence = 1, mutation = null, nativeRev = uuid) =>
  `INSERT INTO "CmsRevision" (id,"datasetId","documentId",sequence,"schemaVersion","nativeRev",payload,"payloadSha256","actorId","mutationId")
   VALUES ('${uuid}','${dataset}','${document}',${sequence},1,'${nativeRev}','{"title":"fixture"}','${hash}','${editor}',${mutation ? `'${mutation}'` : 'NULL'})`;
const referenceSql = (dataset, revision, target, sourceRef = 'other', path = '/related', state = 'resolved') =>
  `INSERT INTO "CmsReference" ("datasetId","sourceRevisionId",path,"sourceRef",state,"targetDocumentId","updatedAt")
   VALUES ('${dataset}','${revision}','${path}','${sourceRef}','${state}',${target ? `'${target}'` : 'NULL'},NOW())`;

try {
  for (const name of ['initdb', 'pg_ctl', 'psql']) {
    if (!await exists(pg(name))) throw new Error(`PostgreSQL binary unavailable: ${pg(name)}; set PG_BIN to installed PostgreSQL 17 binaries. Tests NOT run.`);
  }
  const prismaCli = require.resolve('prisma/build/index.js');
  temp = await mkdtemp(join(tmpdir(), 'jongo-cms-migration-'));
  data = join(temp, 'data');
  port = await freePort();
  const url = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres?schema=public`;
  Object.assign(env, {
    DATABASE_URL: url, DIRECT_URL: url, SHADOW_DATABASE_URL: url,
    PGPASSWORD: password, PGCONNECT_TIMEOUT: '5', PGCLIENTENCODING: 'UTF8',
    PRISMA_HIDE_UPDATE_MESSAGE: '1', CHECKPOINT_DISABLE: '1'
  });
  const baselineRef = process.env.CMS_MIGRATION_BASE_REF || '42a09afde8718c858f1cf723739b5225728e3c9a';
  const commit = (await run('git', ['rev-parse', '--verify', `${baselineRef}^{commit}`], root)).trim();
  const baseline = await run('git', ['show', `${commit}:prisma/schema.prisma`], root);
  assert.doesNotMatch(baseline, /(?:model|enum)\s+Cms\w+\s*\{/, 'baseline must precede CMS');
  const baselinePath = join(temp, 'baseline.prisma');
  const baselineSql = join(temp, 'baseline.sql');
  await writeFile(baselinePath, baseline);
  // Temporary cwd AND schema prevent Prisma discovering repository dotenv files.
  await writeFile(baselineSql, await run(process.execPath, [prismaCli, 'migrate', 'diff',
    '--from-empty', '--to-schema-datamodel', baselinePath, '--script']));
  const pwfile = join(temp, 'initdb-password');
  await writeFile(pwfile, password, { mode: 0o600 });
  await run(pg('initdb'), ['-D', data, '-U', 'postgres', '--auth=scram-sha-256', '--pwfile', pwfile, '--encoding=UTF8', '--no-locale']);
  await rm(pwfile);
  startAttempted = true;
  await run(pg('pg_ctl'), ['-D', data, '-l', join(temp, 'postgres.log'), '-w', '-t', '30',
    '-o', `-h 127.0.0.1 -p ${port}${process.platform === 'win32' ? '' : ` -k "${temp}"`}`, 'start']);
  assert.equal(resolve(await sql('SHOW data_directory')).toLowerCase(), resolve(data).toLowerCase(), 'only our cluster');
  assert.equal(await sql('SHOW listen_addresses'), '127.0.0.1');
  console.log(`Isolated PostgreSQL 127.0.0.1:${port}; pre-CMS Git HEAD ${commit}`);
  if (process.argv.includes('--fail-after-start')) throw new Error('Intentional cleanup rehearsal');
  await fileSql(baselineSql);
  await sql(`
    INSERT INTO "User" (id,email,"updatedAt") VALUES ('${owner}','owner@example.invalid',NOW()),('${editor}','editor@example.invalid',NOW());
    INSERT INTO "Organization" (id,slug,name,"ownerId","updatedAt") VALUES
      ('${orgA}','cms-a','CMS A','${owner}',NOW()),('${orgB}','cms-b','CMS B','${owner}',NOW());
    INSERT INTO "Site" (id,"organizationId",slug,name,"updatedAt") VALUES
      ('${siteA}','${orgA}','site-a','Site A',NOW()),('${siteB}','${orgB}','site-b','Site B',NOW());
    INSERT INTO "Collaborator" ("organizationId","userId",role,"updatedAt") VALUES ('${orgA}','${editor}','collaborator',NOW());
  `);
  const snapshot = async () => JSON.parse(await sql(`SELECT json_build_array(
    (SELECT json_agg(t ORDER BY id) FROM "User" t),
    (SELECT json_agg(t ORDER BY id) FROM "Organization" t),
    (SELECT json_agg(t ORDER BY id) FROM "Site" t),
    (SELECT json_agg(t ORDER BY id) FROM "Collaborator" t))`));
  const before = await snapshot();
  const migration = join(root, 'prisma/migrations/20261019120000_cms_persistence_foundation/migration.sql');
  assert.match(await readFile(migration, 'utf8'), /CREATE TABLE "CmsDataset"/);
  await fileSql(migration);

  await check('migration preserves users, roles, tenants, sites and membership; creates no CMS grants/content', async () => {
    assert.deepEqual(await snapshot(), before);
    for (const table of ['CmsDataset','CmsDatasetGrant','CmsDocument','CmsMutation','CmsRevision','CmsReference']) {
      assert.equal(await sql(`SELECT count(*) FROM "${table}"`), '0');
    }
  });
  await sql(`INSERT INTO "CmsDataset" (id,"organizationId","siteId",key,environment,name,"updatedAt") VALUES
    ('${dsA}','${orgA}','${siteA}','content','test','A',NOW()),
    ('${dsB}','${orgB}',NULL,'content','test','B',NOW());`);
  await check('dataset site must belong to the exact organization; ownership moves restricted', async () => {
    await rejected(`UPDATE "CmsDataset" SET "siteId"='${siteB}' WHERE id='${dsA}'`, '23503', 'CmsDataset_siteId_organizationId_fkey');
    await rejected(`UPDATE "Site" SET "organizationId"='${orgB}' WHERE id='${siteA}'`, '23503', 'CmsDataset_siteId_organizationId_fkey');
    await rejected(`INSERT INTO "CmsDataset" ("organizationId",key,environment,name,"updatedAt") VALUES ('${orgA}','content','test','duplicate',NOW())`, '23505', 'CmsDataset_organizationId_key_environment_key');
    await rejected(`UPDATE "CmsDataset" SET key='' WHERE id='${dsA}'`, '23514', 'CmsDataset_names_check');
  });
  await check('grants default to reader; unique even when revoked; membership grants nothing implicitly', async () => {
    assert.equal(await sql(`INSERT INTO "CmsDatasetGrant" ("datasetId","userId","updatedAt") VALUES ('${dsA}','${editor}',NOW()) RETURNING role`), 'reader');
    await sql(`UPDATE "CmsDatasetGrant" SET "revokedAt"=NOW() WHERE "datasetId"='${dsA}'`);
    await rejected(`INSERT INTO "CmsDatasetGrant" ("datasetId","userId","updatedAt") VALUES ('${dsA}','${editor}',NOW())`, '23505', 'CmsDatasetGrant_datasetId_userId_key');
    await sql(`INSERT INTO "CmsDatasetGrant" ("datasetId","userId","updatedAt") VALUES ('${dsB}','${editor}',NOW())`);
    await rejected(`UPDATE "CmsDatasetGrant" SET role='owner' WHERE "datasetId"='${dsA}'`, '22P02');
  });
  await sql(`${documentSql(draft, dsA, 'drafts.source-text-id', 'source-text-id')};
    ${documentSql(published, dsA, 'source-text-id', 'source-text-id', 'published')};
    ${documentSql(other, dsB, 'other', 'other')};
    ${mutationSql(mutationA, dsA, 'request-1')}; ${mutationSql(mutationB, dsB, 'request-1')};
    ${revisionSql(revA, dsA, draft, 1, mutationA, 'source-rev-text')};
    ${revisionSql(revB, dsB, other, 1, mutationB)};`);
  await check('source text identities and draft/published pair survive independently of UUID primary keys', async () => {
    assert.deepEqual(JSON.parse(await sql(`SELECT json_agg(json_build_array(id,native_id,"logicalId",variant) ORDER BY variant) FROM "CmsDocument" WHERE "datasetId"='${dsA}'`)), [
      [draft, 'drafts.source-text-id', 'source-text-id', 'draft'], [published, 'source-text-id', 'source-text-id', 'published']
    ]);
    await rejected(documentSql(id(30), dsA, 'source-text-id', 'different'), '23505', 'CmsDocument_datasetId_native_id_key');
    await rejected(documentSql(id(30), dsA, 'different', 'source-text-id'), '23505', 'CmsDocument_datasetId_logicalId_variant_key');
    await rejected(`UPDATE "CmsDocument" SET native_id='rewritten' WHERE id='${draft}'`, '23514', null, 'identity is immutable');
    await rejected(`UPDATE "CmsDocument" SET "lockVersion"=-1 WHERE id='${draft}'`, '23514', 'CmsDocument_lockVersion_check');
  });
  await check('idempotency key is dataset-scoped, request hash validated, receipt append-only', async () => {
    await rejected(mutationSql(id(31), dsA, 'request-1'), '23505', 'CmsMutation_datasetId_key_key');
    await rejected(mutationSql(id(31), dsA, 'bad-hash').replace(hash, 'bad'), '23514', 'CmsMutation_request_check');
    for (const statement of [`UPDATE "CmsMutation" SET result=result WHERE id='${mutationA}'`, `DELETE FROM "CmsMutation" WHERE id='${mutationA}'`, 'TRUNCATE "CmsMutation" CASCADE']) {
      await rejected(statement, '23514', null, 'CmsMutation is append-only');
    }
  });
  await check('revision document/mutation FKs reject cross-dataset identities', async () => {
    await rejected(revisionSql(id(32), dsA, other), '23503', 'CmsRevision_datasetId_documentId_fkey');
    await rejected(revisionSql(id(32), dsA, draft, 2, mutationB), '23503', 'CmsRevision_datasetId_mutationId_fkey');
    await rejected(revisionSql(id(32), dsA, draft), '23505', 'CmsRevision_datasetId_documentId_sequence_key');
    await rejected(revisionSql(id(32), dsA, draft, 2, null, 'source-rev-text'), '23505', 'CmsRevision_datasetId_nativeRev_key');
  });
  await check('current revision pointer requires same dataset AND same document', async () => {
    await sql(`UPDATE "CmsDocument" SET "currentRevisionId"='${revA}' WHERE id='${draft}'`);
    await rejected(`UPDATE "CmsDocument" SET "currentRevisionId"='${revB}' WHERE id='${draft}'`, '23503', 'CmsDocument_datasetId_id_currentRevisionId_fkey');
    await rejected(`UPDATE "CmsDocument" SET "currentRevisionId"='${revA}' WHERE id='${published}'`, '23503', 'CmsDocument_datasetId_id_currentRevisionId_fkey');
  });
  await check('revision UPDATE, no-op UPDATE, DELETE and TRUNCATE are rejected', async () => {
    for (const statement of [`UPDATE "CmsRevision" SET payload='{}' WHERE id='${revA}'`, `UPDATE "CmsRevision" SET payload=payload WHERE id='${revA}'`, `DELETE FROM "CmsRevision" WHERE id='${revA}'`, 'TRUNCATE "CmsRevision" CASCADE']) {
      await rejected(statement, '23514', null, 'CmsRevision is append-only');
    }
    assert.equal(await sql(`SELECT payload->>'title' FROM "CmsRevision" WHERE id='${revA}'`), 'fixture');
  });
  await check('revision payload/version/hash/source-pair constraints validate actual SQL rows', async () => {
    const valid = revisionSql(id(33), dsA, draft, 2);
    await rejected(valid.replace(',2,1,', ',0,1,'), '23514', 'CmsRevision_version_check');
    await rejected(valid.replace('{"title":"fixture"}', '[]'), '23514', 'CmsRevision_payload_check');
    await rejected(valid.replace(hash, 'bad'), '23514', 'CmsRevision_payload_check');
    await rejected(`INSERT INTO "CmsRevision" ("datasetId","documentId",sequence,"schemaVersion",payload,"payloadSha256","sourceRecordRaw") VALUES ('${dsA}','${draft}',2,1,'{}','${hash}','raw source')`, '23514', 'CmsRevision_source_check');
    await sql(`INSERT INTO "CmsRevision" (id,"datasetId","documentId",sequence,"schemaVersion",payload,"payloadSha256","sourceRecordRaw","sourceSha256","sourceRev","sourceCreatedAt") VALUES ('${id(33)}','${dsA}','${draft}',2,1,'{}','${hash}','raw source','${hash}','arbitrary-source-rev','non-normalized-source-time')`);
  });
  await check('references reject cross-dataset source/target and mismatched exact source text', async () => {
    await rejected(referenceSql(dsA, revB, published, 'source-text-id'), '23503', 'CmsReference_datasetId_sourceRevisionId_fkey');
    await rejected(referenceSql(dsA, revA, other), '23503', 'CmsReference_datasetId_targetDocumentId_sourceRef_fkey');
    await rejected(referenceSql(dsA, revA, published, 'wrong-spelling'), '23503', 'CmsReference_datasetId_targetDocumentId_sourceRef_fkey');
    await sql(referenceSql(dsA, revA, published, 'source-text-id'));
    await rejected(referenceSql(dsA, revA, published, 'source-text-id'), '23505', 'CmsReference_datasetId_sourceRevisionId_path_key');
  });
  await check('reference path/resolution/empty-state checks retain unresolved/excluded/invalid records', async () => {
    await rejected(referenceSql(dsA, revA, null, 'missing', '/missing', 'resolved'), '23514', 'CmsReference_resolution_check');
    await rejected(referenceSql(dsA, revA, published, 'source-text-id', '/missing', 'unresolved'), '23514', 'CmsReference_resolution_check');
    await rejected(referenceSql(dsA, revA, null, 'missing', 'not-a-pointer', 'unresolved'), '23514', 'CmsReference_path_check');
    await rejected(referenceSql(dsA, revA, null, '', '/empty', 'unresolved'), '23514', 'CmsReference_empty_check');
    for (const state of ['unresolved','excluded','invalid']) await sql(referenceSql(dsA, revA, null, state === 'invalid' ? '' : 'missing', `/${state}`, state));
    await sql(referenceSql(dsA, revA, null, 'root-ref', '', 'unresolved'));
  });
  await check('failed audit insertion rolls back receipt, revision and document pointer atomically', async () => {
    await rejected(`
      ${mutationSql(id(40), dsA, 'rollback')};
      ${revisionSql(id(41), dsA, draft, 3, id(40))};
      UPDATE "CmsDocument" SET "currentRevisionId"='${id(41)}',"lockVersion"=1 WHERE id='${draft}';
      INSERT INTO "AuditLog" ("organizationId","actorId",action) VALUES ('${id(999)}','${editor}','cms.test.rollback')
    `, '23503', 'AuditLog_organizationId_fkey');
    assert.equal(await sql(`SELECT count(*) FROM "CmsMutation" WHERE id='${id(40)}'`), '0');
    assert.equal(await sql(`SELECT count(*) FROM "CmsRevision" WHERE id='${id(41)}'`), '0');
    assert.equal(await sql(`SELECT "currentRevisionId"::text || '/' || "lockVersion" FROM "CmsDocument" WHERE id='${draft}'`), `${revA}/0`);
    assert.equal(await sql(`SELECT count(*) FROM "AuditLog" WHERE action='cms.test.rollback'`), '0');
    await sql(`BEGIN; ${mutationSql(id(40), dsA, 'rollback')}; ${revisionSql(id(41), dsA, draft, 3, id(40))};
      UPDATE "CmsDocument" SET "currentRevisionId"='${id(41)}',"lockVersion"=1 WHERE id='${draft}';
      INSERT INTO "AuditLog" ("organizationId","actorId",action) VALUES ('${orgA}','${editor}','cms.test.commit'); COMMIT;`);
    assert.equal(await sql(`SELECT "currentRevisionId" FROM "CmsDocument" WHERE id='${draft}'`), id(41));
    assert.equal(await sql(`SELECT count(*) FROM "AuditLog" WHERE action='cms.test.commit'`), '1');
  });
  await check('ordinary SQL role cannot bypass append-only triggers with table write privileges', async () => {
    await sql(`CREATE ROLE cms_test_writer NOLOGIN; GRANT USAGE ON SCHEMA public TO cms_test_writer;
      GRANT SELECT,UPDATE,DELETE,TRUNCATE ON "CmsRevision","CmsMutation" TO cms_test_writer;`);
    await rejected(`SET LOCAL ROLE cms_test_writer; UPDATE "CmsRevision" SET payload=payload WHERE id='${revA}'`, '23514', null, 'CmsRevision is append-only');
    await rejected(`SET LOCAL ROLE cms_test_writer; DELETE FROM "CmsMutation" WHERE id='${mutationA}'`, '23514', null, 'CmsMutation is append-only');
  });
  await check('tenant, site, dataset, user and referenced-document deletion cannot destroy CMS history', async () => {
    await rejected(`DELETE FROM "Organization" WHERE id='${orgA}'`, '23503', 'CmsDataset_organizationId_fkey');
    await rejected(`DELETE FROM "Site" WHERE id='${siteA}'`, '23503', 'CmsDataset_siteId_organizationId_fkey');
    await rejected(`DELETE FROM "CmsDataset" WHERE id='${dsA}'`, '23503');
    await rejected(`DELETE FROM "User" WHERE id='${editor}'`, '23503');
    await rejected(`DELETE FROM "CmsDocument" WHERE id='${published}'`, '23503', 'CmsReference_datasetId_targetDocumentId_sourceRef_fkey');
    assert.equal(await sql('SELECT count(*) FROM "Organization"'), '2');
    assert.equal(await sql('SELECT count(*) FROM "CmsRevision"'), '4');
  });
  // Concurrency fixtures follow the original 14 checks so their preservation
  // and row-count assertions remain unchanged. No pg dependency is installed.
  const unrelatedOwner = id(60);
  await sql(`INSERT INTO "User" (id,email,"subscriptionPlanId","subscriptionStatus","updatedAt")
    VALUES ('${unrelatedOwner}','unrelated@example.invalid','core-sla','active',NOW());
    UPDATE "Organization" SET "ownerId"='${unrelatedOwner}' WHERE id='${orgB}';
    UPDATE "User" SET "subscriptionPlanId"='core-sla',"subscriptionStatus"='active' WHERE id='${owner}';
    UPDATE "CmsDatasetGrant" SET role='editor',"revokedAt"=NULL WHERE "datasetId"='${dsA}' AND "userId"='${editor}';
    INSERT INTO "SiteCollaborator" ("siteId","userId",role,"updatedAt") VALUES ('${siteA}','${editor}','collaborator',NOW());`);

  await check('SQL protocol: unrelated tenant owner UPDATE succeeds while scoped policy rows remain locked', async () => {
    const holder = sqlSession();
    const writer = sqlSession();
    try {
      await holder.execute(`BEGIN ISOLATION LEVEL SERIALIZABLE; SET LOCAL statement_timeout='8s'; ${policyLocks()}`);
      assert.equal(await writer.execute(`SET lock_timeout='100ms'; SET statement_timeout='8s';
        UPDATE "User" SET "subscriptionPlanId"='starter' WHERE id='${unrelatedOwner}' RETURNING "subscriptionPlanId";`), 'starter');
      // Prove the selected lock is still held after the unrelated write commits.
      await writer.execute(expectLockTimeout(`UPDATE "User" SET "subscriptionPlanId"='starter' WHERE id='${owner}'`));
      assert.equal(await sql(`SELECT "subscriptionPlanId" FROM "User" WHERE id='${owner}'`), 'core-sla');
      await holder.execute('COMMIT;');
    } finally {
      await Promise.all([holder.close(), writer.close()]);
    }
  });

  await check('SQL protocol: selected owner downgrade hits 55P03 at 100ms, then succeeds after holder COMMIT', async () => {
    const holder = sqlSession();
    const writer = sqlSession();
    try {
      await holder.execute(`BEGIN ISOLATION LEVEL SERIALIZABLE; SET LOCAL statement_timeout='8s'; ${policyLocks()}`);
      await writer.execute(`SET lock_timeout='100ms'; SET statement_timeout='8s';
        ${expectLockTimeout(`UPDATE "User" SET "subscriptionPlanId"='starter' WHERE id='${owner}'`)}`);
      assert.equal(await sql(`SELECT "subscriptionPlanId" FROM "User" WHERE id='${owner}'`), 'core-sla');
      await holder.execute('COMMIT;');
      assert.equal(await writer.execute(`UPDATE "User" SET "subscriptionPlanId"='starter' WHERE id='${owner}' RETURNING "subscriptionPlanId";`), 'starter');
      assert.equal(await sql(`SELECT "subscriptionPlanId" FROM "User" WHERE id='${owner}'`), 'starter');
    } finally {
      await Promise.all([holder.close(), writer.close()]);
    }
    await sql(`UPDATE "User" SET "subscriptionPlanId"='core-sla' WHERE id='${owner}'`);
  });

  await check('SQL protocol: overlapping dataset CAS writers have one winner; SERIALIZABLE loser and fresh stale retry cannot overwrite', async () => {
    const doc = id(70), initial = id(71), winnerRev = id(72), receipt = id(73);
    const loserRev = id(74), loserReceipt = id(75);
    await sql(`${documentSql(doc, dsA, 'drafts.concurrent', 'concurrent')};
      ${revisionSql(initial, dsA, doc)};
      UPDATE "CmsDocument" SET "currentRevisionId"='${initial}' WHERE id='${doc}';`);
    const winner = sqlSession();
    const loser = sqlSession();
    const cas = (revision) => `UPDATE "CmsDocument" SET "currentRevisionId"='${revision}',"lockVersion"="lockVersion"+1
      WHERE "datasetId"='${dsA}' AND id='${doc}' AND variant='draft' AND "archivedAt" IS NULL
      AND "currentRevisionId"='${initial}' AND "lockVersion"=0`;
    try {
      await winner.execute(`BEGIN ISOLATION LEVEL SERIALIZABLE; SET LOCAL statement_timeout='8s'; ${policyLocks()}
        SELECT id FROM "CmsDocument" WHERE "datasetId"='${dsA}' AND id='${doc}' FOR UPDATE;`);
      // Establish a stale snapshot before the winner updates, using an explicit
      // response barrier, not scheduler timing or pg_stat_activity polling.
      assert.equal(await loser.execute(`BEGIN ISOLATION LEVEL SERIALIZABLE; SET LOCAL statement_timeout='8s';
        SELECT "lockVersion" FROM "CmsDocument" WHERE "datasetId"='${dsA}' AND id='${doc}';`), '0');
      await winner.execute(`${mutationSql(receipt, dsA, 'concurrent-winner')};
        ${revisionSql(winnerRev, dsA, doc, 2, receipt).replace('fixture', 'winner')};`);
      assert.equal(await winner.execute(`${cas(winnerRev)} RETURNING "lockVersion";`), '1');
      // This separate session really contends on the dataset row while the
      // winner is uncommitted; catching 55P03 preserves its SERIALIZABLE snapshot.
      await loser.execute(`SET LOCAL lock_timeout='100ms';
        ${expectLockTimeout(`PERFORM id FROM "CmsDataset" WHERE id='${dsA}' FOR UPDATE`)}
        SET LOCAL lock_timeout='2s';`);
      // Submit the competitor before COMMIT. Its snapshot guarantees a real
      // overlap even if the OS executes its statements after the commit.
      const competingCas = loser.execute(`DO $cas_test$ BEGIN
        BEGIN
          PERFORM id FROM "CmsDataset" WHERE id='${dsA}' FOR UPDATE;
          ${mutationSql(loserReceipt, dsA, 'concurrent-loser')};
          ${revisionSql(loserRev, dsA, doc, 3, loserReceipt).replace('fixture', 'loser')};
          ${cas(initial)};
          RAISE EXCEPTION 'Expected serialization_failure SQLSTATE 40001';
        EXCEPTION WHEN SQLSTATE '40001' THEN
          RAISE NOTICE 'expected serialization_failure';
        END;
      END $cas_test$; SELECT 'serialization_conflict';`);
      const [conflict] = await Promise.all([competingCas, winner.execute(`
        INSERT INTO "AuditLog" ("organizationId","actorId",action,"resourceId")
        VALUES ('${orgA}','${editor}','cms.test.concurrent','${doc}'); COMMIT;`)]);
      assert.equal(conflict, 'serialization_conflict');
      await loser.execute('ROLLBACK;');
      // Fresh retry locks in protocol order but retains the caller's stale CAS
      // expectation: exactly zero rows may change, not a silent last-writer win.
      await loser.execute(`BEGIN ISOLATION LEVEL SERIALIZABLE; ${policyLocks()}`);
      assert.equal(await loser.execute(`WITH changed AS (${cas(initial)} RETURNING id)
        SELECT count(*) FROM changed; COMMIT;`), '0');
    } finally {
      await Promise.all([winner.close(), loser.close()]);
    }
    assert.equal(await sql(`SELECT "currentRevisionId"::text || '/' || "lockVersion" FROM "CmsDocument" WHERE id='${doc}'`), `${winnerRev}/1`);
    assert.equal(await sql(`SELECT payload->>'title' FROM "CmsRevision" WHERE id='${winnerRev}'`), 'winner');
    assert.equal(await sql(`SELECT count(*) FROM "CmsRevision" WHERE "documentId"='${doc}'`), '2');
    assert.equal(await sql(`SELECT count(*) FROM "CmsRevision" WHERE id='${loserRev}'`), '0');
    assert.equal(await sql(`SELECT count(*) FROM "CmsMutation" WHERE id='${loserReceipt}'`), '0');
    assert.equal(await sql(`SELECT count(*) FROM "CmsMutation" WHERE key LIKE 'concurrent-%'`), '1');
    assert.equal(await sql(`SELECT count(*) FROM "AuditLog" WHERE action='cms.test.concurrent'`), '1');
  });
  console.log(`PASS all ${checks} real PostgreSQL CMS checks (14 integrity + 3 concurrency; direct SQL protocol only, NOT service proof)`);
} catch (error) {
  console.error(`FAIL ${String(error.message).replaceAll(password, '[redacted]')}`);
  process.exitCode = 1;
} finally {
  try { await cleanup(); } catch (error) {
    console.error(`FAIL cleanup: ${String(error.message).replaceAll(password, '[redacted]')}; retained directory: ${temp}`);
    process.exitCode = 1;
  }
}