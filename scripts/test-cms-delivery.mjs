/** Disposable PostgreSQL + actual route/Prisma credential, media and publication
 * lifecycle checks. Never dotenv or a configured database. Synthetic fixtures only.
 * Generates a client into temp, leaving shared Windows native engines alone. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer, createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testMarketingSql, testMediaSql, testDispatchSql, dispatcherProbe } from './test-cms-marketing-delivery.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const bin = process.env.PG_BIN || (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/17/bin' : '/usr/lib/postgresql/17/bin');
const pg = name => join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(path|systemroot|windir|comspec|pathext|temp|tmp|home|userprofile|localappdata|appdata|lang|lc_all)$/i.test(key)));
const password = randomBytes(32).toString('hex');
const token = `jcms_${randomBytes(32).toString('base64url')}`;
const sha = text => createHash('sha256').update(text).digest('hex');
let temp, data, port, started = false;
async function run(command, args, cwd = temp) {
  return new Promise((accept, reject) => {
    const child = execFile(command, args, { cwd, env, windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return accept(stdout);
      reject(new Error(String(stderr || error.code || 'failed').replaceAll(password, '[redacted]').replaceAll(token, '[redacted]')));
    });
    if (command === pg('pg_ctl')) child.once('exit', () => { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); });
  });
}
async function exists(path) { try { await access(path); return true; } catch { return false; } }
const args = () => ['-X', '-w', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
async function sql(statement) { return (await run(pg('psql'), [...args(), '-qAt', '-c', statement])).trim(); }
const literal = text => `'${text.replaceAll("'", "''")}'`;
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const owner = id(1), org = id(2), ds = id(3), release = id(4), key = id(5);
try {
  for (const name of ['initdb', 'pg_ctl', 'psql']) assert(await exists(pg(name)), 'Install PostgreSQL 17 or set PG_BIN; tests not run.');
  temp = await mkdtemp(join(tmpdir(), 'jongo-delivery-')); data = join(temp, 'data');
  const listener = createServer(); await new Promise((ok, no) => { listener.once('error', no); listener.listen(0, '127.0.0.1', ok); });
  port = listener.address().port; await new Promise(ok => listener.close(ok));
  const url = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres?schema=public`;
  Object.assign(env, { DATABASE_URL: url, DIRECT_URL: url, SHADOW_DATABASE_URL: url, PGPASSWORD: password,
    PGCONNECT_TIMEOUT: '5', PGCLIENTENCODING: 'UTF8', CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' });
  const cli = require.resolve('prisma/build/index.js');
  const baseline = await run('git', ['show', '42a09afde8718c858f1cf723739b5225728e3c9a:prisma/schema.prisma'], root);
  assert.doesNotMatch(baseline, /(?:model|enum)\s+Cms\w+\s*\{/);
  await writeFile(join(temp, 'baseline.prisma'), baseline);
  await writeFile(join(temp, 'baseline.sql'), await run(process.execPath, [cli, 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', join(temp, 'baseline.prisma'), '--script']));
  const schema = (await readFile(join(root, 'prisma/schema.prisma'), 'utf8')).replace(/generator client\s*\{/, `generator client {\n  output = ${JSON.stringify(join(temp, 'client'))}`);
  assert(schema.includes(JSON.stringify(join(temp, 'client'))), 'isolated output required');
  await writeFile(join(temp, 'schema.prisma'), schema);
  await run(process.execPath, [cli, 'validate', '--schema', join(temp, 'schema.prisma')]);
  await run(process.execPath, [cli, 'generate', '--schema', join(temp, 'schema.prisma')]);
  console.log('PASS isolated Prisma schema validation + client generation');
  await writeFile(join(temp, 'pw'), password, { mode: 0o600 });
  await run(pg('initdb'), ['-D', data, '-U', 'postgres', '--auth=scram-sha-256', '--pwfile', join(temp, 'pw'), '--encoding=UTF8', '--no-locale']);
  await rm(join(temp, 'pw')); started = true;
  await run(pg('pg_ctl'), ['-D', data, '-l', join(temp, 'postgres.log'), '-w', '-t', '30', '-o', `-h 127.0.0.1 -p ${port}${process.platform === 'win32' ? '' : ` -k "${temp}"`}`, 'start']);
  assert.equal(resolve(await sql('SHOW data_directory')).toLowerCase(), resolve(data).toLowerCase());
  assert.equal(await sql('SHOW listen_addresses'), '127.0.0.1');
  if (process.argv.includes('--fail-after-start')) throw new Error('Intentional cleanup rehearsal');
  for (const file of [join(temp, 'baseline.sql'), join(root, 'prisma/migrations/20261019120000_cms_persistence_foundation/migration.sql'),
    join(root, 'prisma/migrations/20261020180000_cms_marketing_release_delivery/migration.sql'),
    join(root, 'prisma/migrations/20261020200000_cms_approved_media/migration.sql'),
    join(root, 'prisma/migrations/20261020220000_cms_outbox_dispatch/migration.sql'),
    join(root, 'prisma/migrations/20261020230000_cms_media_cleanup/migration.sql')]) await run(pg('psql'), [...args(), '-f', file]);
  const documents = [{ kind: 'article', id: 'synthetic.article', slug: 'synthetic', title: 'Synthetic test only', excerpt: 'No real approval implied',
    publishedAt: '2026-10-01T00:00:00Z', cover: { src: '/synthetic.webp', alt: 'Synthetic', caption: '' },
    body: [{ _type: 'block', _key: 'b', style: 'normal', children: [{ _type: 'span', _key: 's', text: 'Synthetic', marks: [] }], markDefs: [] }] }];
  const text = JSON.stringify(documents), checksum = sha(text);
  await sql(`INSERT INTO "User" (id,email,"updatedAt") VALUES ('${owner}','synthetic@example.invalid',NOW());
    INSERT INTO "Organization" (id,slug,name,"ownerId","updatedAt") VALUES ('${org}','synthetic','Synthetic','${owner}',NOW());
    INSERT INTO "CmsDataset" (id,"organizationId",key,environment,name,"updatedAt") VALUES ('${ds}','${org}','marketing','test','Synthetic',NOW());
    INSERT INTO "CmsMarketingRelease" (id,"datasetId",sequence,payload,"snapshotText","payloadChecksum") VALUES
      ('${release}','${ds}',1,${literal(JSON.stringify({ documents }))}::jsonb,${literal(text)},'${checksum}');
    INSERT INTO "CmsMarketingPublication" ("datasetId","releaseId",status,revision,"updatedAt") VALUES ('${ds}','${release}','active',1,NOW());
    INSERT INTO "CmsDeliveryCredential" (id,"datasetId","tokenHash",prefix) VALUES ('${key}','${ds}','${sha(token)}','synthetic');`);
  assert.equal(await sql(`SELECT "snapshotText" FROM "CmsMarketingRelease" WHERE id='${release}'`), text);
  assert.notEqual(await sql(`SELECT (payload->'documents')::text FROM "CmsMarketingRelease" WHERE id='${release}'`), text);
  console.log('PASS direct SQL synthetic snapshot retains exact text despite JSONB normalization');
  await testMarketingSql(sql, { ds, release, key, org, id });
  await testMediaSql(sql, { ds, owner, id });
  await testDispatchSql(sql, { ds, id });
  // Only repository TS is transpiled. Alias db import is forbidden: ensures no
  // configured-client fallback or incidental noisy SDK query can enter the read.
  const probe = `
    const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
    const root = ${JSON.stringify(root)}, ts = require(${JSON.stringify(require.resolve('typescript'))});
    const isolated = require(${JSON.stringify(join(temp, 'client'))});
    let genericDb = null;
    const load = Module._load, resolve = Module._resolveFilename;
    Module._load = function(request, parent, main) {
      if (request === '@prisma/client') return isolated;
      if (request === '@/lib/db') return { getDb() { if (!genericDb) throw new Error('Unexpected generic DB read'); return Promise.resolve(genericDb); } };
      return load.call(this, request, parent, main);
    };
    Module._resolveFilename = function(request, parent, ...args) {
      if (request.startsWith('@/')) request = path.join(root, 'apps/web/src', request.slice(2));
      return resolve.call(this, request, parent, ...args);
    };
    require.extensions['.ts'] = (module, filename) => {
      assert(filename.startsWith(root + path.sep) && !filename.includes(path.sep + 'node_modules' + path.sep));
      module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, filename);
    };
    const { GET } = require(path.join(root, 'apps/web/src/app/api/content/v1/datasets/[datasetId]/marketing/route.ts'));
    const { getDeliveryDb } = require(path.join(root, 'apps/web/src/lib/cms/delivery-db.ts'));
    const db = getDeliveryDb(), datasetId = ${JSON.stringify(ds)};
    const auth = 'Bearer ' + process.env.SYNTHETIC_DELIVERY_TOKEN;
    const read = (a = auth, etag) => GET(new Request('http://localhost/', { headers: { ...(a ? { authorization: a } : {}), ...(etag ? { 'if-none-match': etag } : {}) } }), { params: Promise.resolve({ datasetId }) });
    (async () => {
      try {
        const response = await read(); assert.equal(response.status, 200);
        const body = await response.json(); assert.deepEqual(Object.keys(body), ['schemaVersion','datasetId','releaseId','checksum','documents']);
        assert.equal(body.checksum, require('node:crypto').createHash('sha256').update(JSON.stringify(body.documents)).digest('hex'));
        assert.equal(body.documents[0].title, 'Synthetic test only');
        assert.equal(response.headers.get('cache-control'), 'private, no-store');
        assert.equal((await read(auth, response.headers.get('etag'))).status, 304);
        assert.equal((await read(null)).status, 401);
        await db.cmsDeliveryCredential.update({ where: { id: ${JSON.stringify(key)} }, data: { revokedAt: new Date() } });
        assert.equal((await read()).status, 401);
        await db.cmsDeliveryCredential.update({ where: { id: ${JSON.stringify(key)} }, data: { revokedAt: null } });
        await db.cmsMarketingPublication.update({ where: { datasetId }, data: { releaseId: null, status: 'revoked', revision: { increment: 1 } } });
        assert.equal((await read()).status, 404);
        console.log('PASS actual route + isolated Prisma: exact five fields/hash, private headers, 304, missing/revoked token, revoked pointer no fallback');
        process.env.JONGO_CMS_ENABLED = 'true';
        process.env.JONGO_CMS_WRITES_ENABLED = 'true';
        const actor = ${JSON.stringify(owner)};
        await db.user.update({ where: { id: actor }, data: { subscriptionPlanId: 'core-sla', subscriptionStatus: 'active', subscriptionCurrentPeriodEnd: new Date(Date.now() + 86400000) } });
        const { mintMarketingDeliveryCredential: mint, revokeMarketingDeliveryCredential: revoke } = require(path.join(root, 'apps/web/src/lib/cms/deliverycredentials.ts'));
        const { createMarketingRelease } = require(path.join(root, 'apps/web/src/lib/cms/marketing-publication.ts'));
        const minted = await mint(actor, datasetId);
        const stored = await db.cmsDeliveryCredential.findUnique({ where: { id: minted.id } });
        assert.notEqual(stored.tokenHash, minted.token);
        assert.equal(stored.tokenHash, require('node:crypto').createHash('sha256').update(minted.token).digest('hex'));
        const audit = await db.auditLog.findFirst({ where: { action: 'cms.delivery.credential.mint', resourceId: datasetId } });
        assert(audit); assert(!JSON.stringify(audit).includes(minted.token)); assert(!JSON.stringify(audit).includes(stored.tokenHash));
        assert.equal((await read('Bearer ' + minted.token)).status, 404);
        await revoke(actor, datasetId, minted.id);
        assert.equal((await read('Bearer ' + minted.token)).status, 401);
        await assert.rejects(revoke(actor, datasetId, minted.id), e => e.code === 'conflict');
        await db.user.update({ where: { id: actor }, data: { subscriptionPlanId: 'starter' } });
        await assert.rejects(mint(actor, datasetId), e => e.code === 'denied');
        await db.user.update({ where: { id: actor }, data: { subscriptionPlanId: 'core-sla' } });
        await assert.rejects(createMarketingRelease(actor, datasetId, [${JSON.stringify(id(99))}], 0, { publicOrigins: ['https://media.example'] }), e => e.code === 'conflict');
        await assert.rejects(createMarketingRelease(actor, datasetId, [${JSON.stringify(id(99))}], 2, { publicOrigins: ['https://media.example'] }), e => e.code === 'invalid');
        const before = await db.cmsDeliveryCredential.count();
        await db.$executeRawUnsafe(${JSON.stringify("CREATE FUNCTION fail_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic audit failure'; END $$")});
        await db.$executeRawUnsafe('CREATE TRIGGER fail_test_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION fail_test_audit()');
        await assert.rejects(mint(actor, datasetId), e => e.code === 'unavailable');
        assert.equal(await db.cmsDeliveryCredential.count(), before);
        await db.$executeRawUnsafe('DROP TRIGGER fail_test_audit ON "AuditLog"');
        assert.equal(await db.cmsMarketingRelease.count(), 1);
        assert.equal(await db.cmsContentOutbox.count(), 1);
        console.log('PASS real Prisma services: mint/hash/redacted audit, revoke/read denial, repeat conflict, fresh downgrade denial, publication CAS/missing-revision refusal, audit-failure issuance rollback');        // Media: generic write client enabled only after delivery reads proved isolation.
        genericDb = db; process.env.NODE_ENV = 'test';
        const sharp = require(${JSON.stringify(require.resolve('sharp'))}), crypto = require('node:crypto');
        const { createCmsMediaService, loadApprovedMedia } = require(path.join(root, 'apps/web/src/lib/cms/media.ts'));
        const { createIsolatedFileSystemMediaStore } = require(path.join(root, 'apps/web/src/lib/cms/media-local-store.ts'));
        const { runMediaCleanupJob } = require(path.join(root, 'apps/web/src/lib/cms/media-cleanup.ts'));
        const { executeCmsWriteTransaction } = require(path.join(root, 'apps/web/src/lib/cms/documents.ts'));
        const origins = ['https://media.example'];
        const local = await createIsolatedFileSystemMediaStore({ approvedOrigin: origins[0], publicBaseUrl: origins[0] + '/assets/', parentDirectory: ${JSON.stringify(join(temp, 'media'))} });
        const media = createCmsMediaService(local.store, { publicOrigins: origins, cleanup: jobId => runMediaCleanupJob(db, jobId, {
          deleteAllVersions: async key => {
            for (const visibility of ['private', 'public']) fs.rmSync(path.join(local.root, visibility, ...key.split('/')), { force: true });
          },
          purge: async url => { assert(url.startsWith(origins[0] + '/assets/')); }
        }) });
        const editor = ${JSON.stringify(id(80))};
        await db.user.create({ data: { id: editor, email: 'editor@example.invalid' } });
        await db.collaborator.create({ data: { organizationId: ${JSON.stringify(org)}, userId: editor, role: 'collaborator' } });
        await db.cmsDatasetGrant.create({ data: { datasetId, userId: editor, role: 'editor' } });
        const loadIn = (ids, user = actor) => executeCmsWriteTransaction({ userId: user, datasetId }, 'publish', tx => loadApprovedMedia(tx, datasetId, ids, origins));
        const find = id => db.cmsApprovedMedia.findUnique({ where: { id } });
        const png = await sharp({ create: { width: 12, height: 9, channels: 3, background: 'red' } }).withExif({ IFD0: { Copyright: 'PRIVATE' } }).png().toBuffer();
        const staged = await media.stageApprovedImage(editor, datasetId, png, 'image/png', { alt: 'Synthetic approved', nativeId: 'image-real' });
        let row = await find(staged.id);
        assert.equal(row.status, 'pending'); assert.equal(row.url, null); assert.equal(row.createdBy, editor); assert.equal(row.mimeType, 'image/webp');
        const bytes = await local.store.getPrivate(row.objectKey);
        assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), row.sha256); assert.equal(bytes.length, row.byteSize);
        const meta = await sharp(bytes).metadata();
        assert.equal(meta.format, 'webp'); assert.equal(meta.width, 12); assert.equal(meta.exif, undefined);
        await assert.rejects(local.store.getPublic(row.objectKey));
        await assert.rejects(loadIn(['image-real']), e => e.code === 'invalid');
        await assert.rejects(media.approveMedia(editor, datasetId, staged.id), e => e.code === 'denied');
        await db.user.update({ where: { id: actor }, data: { subscriptionPlanId: 'starter' } });
        await assert.rejects(media.approveMedia(actor, datasetId, staged.id), e => e.code === 'denied');
        await db.user.update({ where: { id: actor }, data: { subscriptionPlanId: 'core-sla' } });
        await assert.rejects(local.store.getPublic(row.objectKey));
        assert.equal((await find(staged.id)).status, 'pending');
        await media.approveMedia(actor, datasetId, staged.id);
        row = await find(staged.id);
        assert.equal(row.status, 'approved'); assert.equal(row.reviewerId, actor); assert.equal(row.url, origins[0] + '/assets/' + row.objectKey);
        assert((await local.store.getPublic(row.objectKey)).equals(bytes));
        await assert.rejects(media.approveMedia(actor, datasetId, staged.id), e => e.code === 'conflict');
        const resolved = await executeCmsWriteTransaction({ userId: actor, datasetId }, 'publish', async tx =>
          (await loadApprovedMedia(tx, datasetId, ['image-real'], origins)).resolveAsset({ _type: 'reference', _ref: 'image-real' }, { datasetId }));
        assert.deepEqual(resolved, { url: row.url, alt: 'Synthetic approved', caption: '' });
        await assert.rejects(loadIn(['image-real'], editor), e => e.code === 'denied');
        const second = await media.stageApprovedImage(actor, datasetId, png, 'image/png', { alt: 'Second', nativeId: 'image-tampered' });
        const tampered = await find(second.id);
        fs.writeFileSync(path.join(local.root, 'private', ...tampered.objectKey.split('/')), 'tampered');
        await assert.rejects(media.approveMedia(actor, datasetId, second.id), e => e.code === 'invalid');
        assert.equal((await find(second.id)).status, 'pending');
        await assert.rejects(media.revokeMedia(editor, datasetId, staged.id), e => e.code === 'denied');
        await media.revokeMedia(actor, datasetId, staged.id);
        assert.equal((await find(staged.id)).status, 'revoked');
        assert.equal(await db.cmsMediaCleanupJob.count({ where: { mediaId: staged.id, status: 'complete' } }), 1);
        assert.equal(fs.existsSync(path.join(local.root, 'public', ...row.objectKey.split('/'))), false);
        await assert.rejects(loadIn(['image-real']), e => e.code === 'invalid');
        await assert.rejects(media.revokeMedia(actor, datasetId, staged.id), e => e.code === 'conflict');
        const audits = await db.auditLog.groupBy({ by: ['action'], where: { action: { startsWith: 'cms.media.' } }, _count: true });
        assert.deepEqual(Object.fromEntries(audits.map(a => [a.action, a._count])), { 'cms.media.stage': 2, 'cms.media.approve': 1, 'cms.media.revoke': 1, 'cms.media.cleanup.complete': 1 });
        console.log('PASS real Prisma media: stage/verify/promote, publish projection, tamper refusal, DB-first revocation, durable cleanup, audit');
        // Real lifecycle on a fresh dataset: native drafts + approved media -> release -> GET -> unpublish -> rollback.
        const { saveCmsDraft } = require(path.join(root, 'apps/web/src/lib/cms/documents.ts'));
        const { unpublishMarketing, rollbackMarketingRelease } = require(path.join(root, 'apps/web/src/lib/cms/marketing-publication.ts'));
        const life = ${JSON.stringify(id(300))};
        await db.cmsDataset.create({ data: { id: life, organizationId: ${JSON.stringify(org)}, key: 'marketing-lifecycle', environment: 'test', name: 'Synthetic lifecycle' } });
        await db.user.update({ where: { id: actor }, data: { subscriptionPlanId: 'core-sla', subscriptionStatus: 'active', subscriptionCurrentPeriodEnd: new Date(Date.now() + 86400000) } });
        const lifeMedia = {};
        for (const [nativeId, alt, color] of [['image-life-card', 'Work card', 'blue'], ['image-life-gallery', 'Work gallery', 'green'],
          ['image-life-portrait', 'Portrait', 'yellow'], ['image-life-cover', 'Article cover', 'purple'], ['image-life-body', 'Article body', 'orange']]) {
          const input = await sharp({ create: { width: 16, height: 10, channels: 3, background: color } }).png().toBuffer();
          lifeMedia[nativeId] = (await media.stageApprovedImage(actor, life, input, 'image/png', { alt, nativeId })).id;
        }
        const ref = r => ({ _type: 'reference', _ref: r });
        const envelope = (nativeId, type) => ({ _id: nativeId, _type: type, _rev: 'synthetic-rev', _createdAt: '2026-10-01T00:00:00Z', _updatedAt: '2026-10-01T00:00:00Z' });
        const approval = { status: 'approved', evidence: 'Synthetic disposable test evidence', reviewer: 'Synthetic reviewer', approvedAt: '2026-10-01T00:00:00Z' };
        const provenance = { source: 'Synthetic disposable test fixture' };
        const drafts = {
          work: { ...envelope('drafts.work.lifecycle', 'agencyWork'), slug: { _type: 'slug', current: 'lifecycle-work' }, clientName: 'Synthetic Client',
            category: 'Synthetic', tone: 'sage', cardAsset: ref('image-life-card'),
            gallery: [{ _type: 'mediaImage', _key: 'g1', asset: ref('image-life-gallery'), alt: 'Synthetic gallery' }],
            services: ['Synthetic service'], headline: 'Synthetic headline', detailSummary: 'Synthetic summary.', provenance, publicationApproval: approval },
          story: { ...envelope('drafts.story.lifecycle', 'partnerStories'), slug: { _type: 'slug', current: 'lifecycle-story' }, company: 'Synthetic Co',
            personName: 'Synthetic Person', role: 'Synthetic role', textBadge: 'Synthetic Co',
            portrait: { _type: 'mediaImage', asset: ref('image-life-portrait'), alt: 'Synthetic portrait' }, quote: 'Synthetic quote.', tone: 'lime',
            relatedWork: ref('work.lifecycle'), relatedWorkVerified: true, consent: { ...approval, quote: true, likeness: true }, provenance },
          article: { ...envelope('drafts.article.lifecycle', 'article'), slug: { _type: 'slug', current: 'lifecycle-article' }, title: 'Synthetic article',
            excerpt: 'Synthetic excerpt', publishedAt: '2026-10-01T00:00:00Z',
            body: [{ _type: 'block', _key: 'b1', style: 'normal', children: [{ _type: 'span', _key: 's1', text: 'Synthetic body', marks: ['strong'] }], markDefs: [] },
              { _type: 'image', _key: 'i1', asset: ref('image-life-body'), alt: 'Synthetic inline' }],
            cover: { _type: 'mediaImage', asset: ref('image-life-cover'), alt: 'Synthetic cover' }, provenance, publicationApproval: approval }
        };
        const saved = {};
        for (const [name, input] of Object.entries(drafts)) saved[name] = await saveCmsDraft({ userId: actor, datasetId: life, sourceId: input._id, input, mutationId: 'lifecycle-' + name });
        const order = [saved.article.revisionId, saved.work.revisionId, saved.story.revisionId], origin = { publicOrigins: origins };
        await assert.rejects(createMarketingRelease(actor, life, order, 0, origin), e => e.code === 'invalid');
        for (const mediaId of Object.values(lifeMedia)) await media.approveMedia(actor, life, mediaId);
        const pending = await saveCmsDraft({ userId: actor, datasetId: life, sourceId: 'drafts.story.pending', mutationId: 'lifecycle-pending',
          input: { ...drafts.story, _id: 'drafts.story.pending', slug: { _type: 'slug', current: 'lifecycle-pending' }, consent: { ...drafts.story.consent, status: 'pending' } } });
        await assert.rejects(createMarketingRelease(actor, life, [...order, pending.revisionId], 0, origin), e => e.code === 'invalid');
        await assert.rejects(createMarketingRelease(actor, life, [], 0, origin), e => e.code === 'invalid');
        await assert.rejects(createMarketingRelease(editor, life, order, 0, origin), e => e.code === 'denied');
        assert.equal(await db.cmsMarketingRelease.count({ where: { datasetId: life } }), 0);
        assert.equal(await db.cmsMarketingPublication.count({ where: { datasetId: life } }), 0);
        const published = await createMarketingRelease(actor, life, order, 0, origin);
        assert.equal(published.publicationRevision, 1); assert.equal(published.sequence, 1); assert.equal(published.documentCount, 3);
        await assert.rejects(createMarketingRelease(actor, life, order, 0, origin), e => e.code === 'conflict');
        const lifeAuth = 'Bearer ' + (await mint(actor, life)).token;
        const readLife = a => GET(new Request('http://localhost/', { headers: { authorization: a } }), { params: Promise.resolve({ datasetId: life }) });
        let lifeResponse = await readLife(lifeAuth); assert.equal(lifeResponse.status, 200);
        let lifeBody = await lifeResponse.json();
        assert.deepEqual(Object.keys(lifeBody), ['schemaVersion', 'datasetId', 'releaseId', 'checksum', 'documents']);
        assert.equal(lifeBody.releaseId, published.releaseId); assert.equal(lifeBody.checksum, published.checksum);
        assert.equal(lifeBody.checksum, crypto.createHash('sha256').update(JSON.stringify(lifeBody.documents)).digest('hex'));
        assert.deepEqual(lifeBody.documents.map(d => d.kind + ':' + d.id), ['article:article.lifecycle', 'workCaseStudy:work.lifecycle', 'testimonial:story.lifecycle']);
        const lifeRows = await db.cmsApprovedMedia.findMany({ where: { datasetId: life } });
        const urlOf = nativeId => lifeRows.find(row => row.nativeId === nativeId).url;
        assert.equal(lifeBody.documents[1].cardImage.src, urlOf('image-life-card'));
        assert.equal(lifeBody.documents[1].gallery[0].src, urlOf('image-life-gallery'));
        assert.equal(lifeBody.documents[2].portrait, urlOf('image-life-portrait'));
        assert.equal(lifeBody.documents[0].cover.src, urlOf('image-life-cover'));
        assert.equal(lifeBody.documents[0].body[1].src, urlOf('image-life-body'));
        assert.doesNotMatch(JSON.stringify(lifeBody), /drafts\\.|consent|provenance|publicationApproval|objectKey|relatedWork|sha256/);
        assert.equal((await db.cmsRevision.findUnique({ where: { id: saved.work.revisionId } })).payload._id, 'drafts.work.lifecycle');
        const releaseRow = await db.cmsMarketingRelease.findUnique({ where: { id: published.releaseId } });
        assert.equal(releaseRow.snapshotText, JSON.stringify(lifeBody.documents)); assert.equal(releaseRow.actorId, actor);
        await assert.rejects(unpublishMarketing(actor, life, 0), e => e.code === 'invalid');
        await assert.rejects(unpublishMarketing(actor, life, 2), e => e.code === 'conflict');
        assert.deepEqual(await unpublishMarketing(actor, life, 1), { datasetId: life, releaseId: published.releaseId, publicationRevision: 2 });
        assert.equal((await readLife(lifeAuth)).status, 404);
        assert.equal(await db.cmsMarketingRelease.count({ where: { datasetId: life } }), 1);
        assert.deepEqual(await rollbackMarketingRelease(actor, life, published.releaseId, 2), { datasetId: life, releaseId: published.releaseId, publicationRevision: 3 });
        lifeResponse = await readLife(lifeAuth); assert.equal(lifeResponse.status, 200);
        lifeBody = await lifeResponse.json();
        assert.equal(lifeBody.releaseId, published.releaseId); assert.equal(lifeBody.checksum, published.checksum);
        assert.equal(lifeBody.checksum, crypto.createHash('sha256').update(JSON.stringify(lifeBody.documents)).digest('hex'));
        await assert.rejects(rollbackMarketingRelease(actor, life, published.releaseId, 3), e => e.code === 'conflict');
        const events = await db.cmsContentOutbox.findMany({ where: { datasetId: life }, orderBy: { publicationRevision: 'asc' } });
        assert.deepEqual(events.map(e => e.eventType + ':' + e.publicationRevision + ':' + e.releaseId),
          ['release_publish:1:', 'release_unpublish:2:', 'release_publish:3:'].map(prefix => prefix + published.releaseId));
        const lifeAudit = await db.auditLog.findMany({ where: { resourceId: life, action: { startsWith: 'cms.marketing.release.' } } });
        assert.deepEqual(lifeAudit.map(a => a.action).sort(), ['cms.marketing.release.publish', 'cms.marketing.release.rollback', 'cms.marketing.release.unpublish']);
        await (${dispatcherProbe.toString()})({ db, datasetId: life, releaseId: published.releaseId, root });
        await unpublishMarketing(actor, life, 3);
        await media.revokeMedia(actor, life, lifeMedia['image-life-body']);
        await assert.rejects(rollbackMarketingRelease(actor, life, published.releaseId, 4), e => e.code === 'invalid');
        await assert.rejects(createMarketingRelease(actor, life, order, 4, origin), e => e.code === 'invalid');
        assert.equal((await readLife(lifeAuth)).status, 404);
        assert.equal((await db.cmsMarketingPublication.findUnique({ where: { datasetId: life } })).revision, 4);
        console.log('PASS real publication lifecycle: saveCmsDraft Work/Testimonial/Article + approved media, unapproved media/pending consent/empty/editor refusals with no writes, explicit draft promotion, caller order, actual GET checksum, CAS conflict, unpublish 404 with retained release, rollback restores, outbox+audit, revoked media blocks rollback/republish');      } finally { await db.$disconnect(); }
    })().catch(error => {
      const detail = String(error?.code || '') + ' ' + String(error?.message || '').slice(0, 400);
      console.error('FAIL redacted isolated delivery probe: ' + detail.replace(/jcms_[A-Za-z0-9_-]{43}/g, '[redacted]').replace(/postgres(?:ql)?:\\/\\/\\S+/g, '[redacted]'));
      process.exitCode = 1;
    });
  `;
  await writeFile(join(temp, 'probe.cjs'), probe);
  await mkdir(join(temp, 'media'));
  env.SYNTHETIC_DELIVERY_TOKEN = token;
  console.log((await run(process.execPath, [join(temp, 'probe.cjs')])).trim());
  console.log('PASS isolated SQL/read/credential/media/publication lifecycle on a disposable cluster with synthetic fixtures only');
} catch (error) {
  console.error(String(error?.message || 'Isolated delivery failure').replaceAll(password, '[redacted]').replaceAll(token, '[redacted]')); process.exitCode = 1;
} finally {
  if (temp) {
    try {
      if (started && await exists(join(data, 'postmaster.pid'))) {
        await run(pg('pg_ctl'), ['-D', data, '-m', 'fast', '-w', '-t', '30', 'stop']);
        assert.equal(await exists(join(data, 'postmaster.pid')), false);
        const open = await new Promise(ok => { const socket = createConnection({ host: '127.0.0.1', port });
          socket.setTimeout(2000); socket.once('connect', () => { socket.destroy(); ok(true); });
          socket.once('error', () => { socket.destroy(); ok(false); }); socket.once('timeout', () => { socket.destroy(); ok(true); }); });
        assert.equal(open, false);
      }
      await rm(temp, { recursive: true, force: true, maxRetries: 3 }); assert.equal(await exists(temp), false);
      console.log('PASS cleanup: own temporary cluster stopped and directory removed');
    } catch { console.error('FAIL isolated cleanup; operator inspection required'); process.exitCode = 1; }
  }
}