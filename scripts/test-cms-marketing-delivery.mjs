/** Persisted release SQL checks, reusing the existing disposable delivery harness.
 * No dotenv, configured DB, shared client generation or publication approval. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

export async function testMarketingSql(sql, { ds, release, key, org, id }) {
  let checks = 0;
  async function rejects(name, statement, state, constraint) {
    await sql(`DO $check$ DECLARE c text; BEGIN BEGIN
      ${statement}; RAISE EXCEPTION 'Unexpected success';
      EXCEPTION WHEN SQLSTATE '${state}' THEN
        GET STACKED DIAGNOSTICS c = CONSTRAINT_NAME;
        ${constraint ? `IF c <> '${constraint}' THEN RAISE EXCEPTION 'Unexpected constraint %', c; END IF;` : ''}
      END; END $check$;`);
    console.log(`PASS release SQL ${++checks}: ${name}`);
  }
  const ds2 = id(90);
  await sql(`INSERT INTO "CmsDataset" (id,"organizationId",key,environment,name,"updatedAt") VALUES
    ('${ds2}','${org}','other','test','Synthetic second dataset',NOW())`);
  const insert = (columns, values) => `INSERT INTO "CmsMarketingRelease" ("datasetId",sequence,payload,"snapshotText","payloadChecksum"${columns}) VALUES ('${ds}',2,'{"documents":[]}','[]','${'a'.repeat(64)}'${values})`;
  await rejects('release sequence unique per dataset', insert('', '').replace(',2,', ',1,'), '23505', 'CmsMarketingRelease_datasetId_sequence_key');
  await rejects('positive sequence', insert('', '').replace(',2,', ',0,'), '23514', 'CmsMarketingRelease_version_check');
  await rejects('only version one', insert(',version', ',2'), '23514', 'CmsMarketingRelease_version_check');
  await rejects('checksum shape', insert('', '').replace('a'.repeat(64), 'bad'), '23514', 'CmsMarketingRelease_checksum_check');
  await rejects('missing documents fails closed', insert('', '').replace('{"documents":[]}', '{}'), '23514', 'CmsMarketingRelease_payload_check');
  await rejects('mirror cannot contain private fields', insert('', '').replace('{"documents":[]}', '{"documents":[],"private":true}'), '23514', 'CmsMarketingRelease_payload_check');
  await rejects('text/mirror mismatch', insert('', '').replace("'[]'", "'[1]'"), '23514', 'CmsMarketingRelease_payload_check');
  await rejects('maximum 100 documents', `INSERT INTO "CmsMarketingRelease" ("datasetId",sequence,payload,"snapshotText","payloadChecksum") SELECT '${ds}',2,jsonb_build_object('documents',j),j::text,'${'a'.repeat(64)}' FROM (SELECT jsonb_agg(n) j FROM generate_series(1,101) n) s`, '23514', 'CmsMarketingRelease_payload_check');
  await rejects('snapshot byte bound', `INSERT INTO "CmsMarketingRelease" ("datasetId",sequence,payload,"snapshotText","payloadChecksum") SELECT '${ds}',2,jsonb_build_object('documents',j),j::text,'${'a'.repeat(64)}' FROM (SELECT jsonb_build_array(repeat('x',1048576)) j) s`, '23514', 'CmsMarketingRelease_payload_check');
  await rejects('immutable update', `UPDATE "CmsMarketingRelease" SET sequence=sequence WHERE id='${release}'`, '23514');
  await rejects('immutable delete', `DELETE FROM "CmsMarketingRelease" WHERE id='${release}'`, '23514');
  await rejects('immutable truncate', 'TRUNCATE "CmsMarketingRelease" CASCADE', '23514');
  await rejects('publication cannot cross datasets', `INSERT INTO "CmsMarketingPublication" ("datasetId","releaseId",status,revision,"updatedAt") VALUES ('${ds2}','${release}','active',1,NOW())`, '23503', 'CmsMarketingPublication_datasetId_releaseId_fkey');
  await rejects('active publication requires pointer', `UPDATE "CmsMarketingPublication" SET "releaseId"=NULL WHERE "datasetId"='${ds}'`, '23514', 'CmsMarketingPublication_pointer_check');
  await rejects('revoked publication must clear pointer', `UPDATE "CmsMarketingPublication" SET status='revoked' WHERE "datasetId"='${ds}'`, '23514', 'CmsMarketingPublication_pointer_check');
  await rejects('credential read-only scope', `UPDATE "CmsDeliveryCredential" SET type='cms.write' WHERE id='${key}'`, '23514', 'CmsDeliveryCredential_scope_check');
  await rejects('credential hash globally unique', `INSERT INTO "CmsDeliveryCredential" ("datasetId","tokenHash",prefix) SELECT '${ds2}',"tokenHash",'duplicate' FROM "CmsDeliveryCredential" WHERE id='${key}'`, '23505', 'CmsDeliveryCredential_tokenHash_key');
  await rejects('credential expiry must follow creation', `UPDATE "CmsDeliveryCredential" SET "expiresAt"="createdAt" WHERE id='${key}'`, '23514', 'CmsDeliveryCredential_expiry_check');
  const outbox = (dataset = ds, revision = 1, extra = '') => `INSERT INTO "CmsContentOutbox" ("datasetId","releaseId","publicationRevision","eventType",payload,"updatedAt"${extra ? ',status' : ''}) VALUES ('${dataset}','${release}',${revision},'release_publish','{}',NOW()${extra ? `,'${extra}'` : ''})`;
  await rejects('outbox cannot cross datasets', outbox(ds2), '23503', 'CmsContentOutbox_datasetId_releaseId_fkey');
  await rejects('delivered outbox requires timestamp', outbox(ds, 1, 'delivered'), '23514', 'CmsContentOutbox_delivery_check');
  await sql(outbox());
  await rejects('one outbox event per publication revision', outbox(), '23505', 'CmsContentOutbox_datasetId_publicationRevision_key');
  await rejects('dataset history cannot be deleted', `DELETE FROM "CmsDataset" WHERE id='${ds}'`, '23503');
  assert.equal(await sql(`SELECT count(*) FROM "CmsMarketingRelease"`), '1');
  console.log(`PASS ${checks} release SQL rejection checks; original synthetic release preserved`);
}

/** Synthetic rows only: SQL constraints, NOT byte verification or approval proof. */
export async function testMediaSql(sql, { ds, owner, id }) {
  let checks = 0;
  async function rejects(name, statement, state, constraint) {
    await sql(`DO $check$ DECLARE c text; BEGIN BEGIN
      ${statement}; RAISE EXCEPTION 'Unexpected success';
      EXCEPTION WHEN SQLSTATE '${state}' THEN
        GET STACKED DIAGNOSTICS c = CONSTRAINT_NAME;
        ${constraint ? `IF c <> '${constraint}' THEN RAISE EXCEPTION 'Unexpected constraint %', c; END IF;` : ''}
      END; END $check$;`);
    console.log(`PASS media SQL ${++checks}: ${name}`);
  }
  const ds2 = id(90), media = id(70), hash = 'b'.repeat(64), objectKey = `${ds}/${media}/${hash}.webp`;
  const url = `https://media.example/assets/${objectKey}`;
  const row = (o = {}) => {
    const v = { id: media, datasetId: ds, nativeId: 'image-synthetic', objectKey, sha256: hash, mimeType: 'image/webp',
      width: 10, height: 10, byteSize: 100, alt: 'Synthetic', createdBy: owner, ...o };
    const cols = Object.keys(v), vals = Object.values(v).map(x => x === null ? 'NULL' : typeof x === 'number' ? String(x) : `'${String(x).replaceAll("'", "''")}'`);
    return `INSERT INTO "CmsApprovedMedia" (${cols.map(c => `"${c}"`).join(',')}) VALUES (${vals.join(',')})`;
  };
  const other = id(71), otherKey = `${ds}/${other}/${hash}.webp`;
  await rejects('object key bound to own dataset/id/hash', row({ objectKey: `${ds2}/${media}/${hash}.webp` }), '23514', 'CmsApprovedMedia_identity_check');
  await rejects('draft native ids refused', row({ nativeId: 'drafts.image' }), '23514', 'CmsApprovedMedia_identity_check');
  await rejects('file assets refused', row({ assetType: 'sanity.fileAsset' }), '23514', 'CmsApprovedMedia_identity_check');
  await rejects('stored rendition is WebP only', row({ mimeType: 'image/svg+xml' }), '23514', 'CmsApprovedMedia_raster_check');
  await rejects('source raster MIME is not a stored rendition', row({ mimeType: 'image/png' }), '23514', 'CmsApprovedMedia_raster_check');
  await rejects('pixel limit', row({ width: 16384, height: 16384 }), '23514', 'CmsApprovedMedia_raster_check');
  await rejects('byte limit', row({ byteSize: 20971521 }), '23514', 'CmsApprovedMedia_raster_check');
  await rejects('sha shape', row({ sha256: 'B'.repeat(64), objectKey: `${ds}/${media}/${'B'.repeat(64)}.webp` }), '23514', 'CmsApprovedMedia_raster_check');
  await rejects('alt required', row({ alt: '   ' }), '23514', 'CmsApprovedMedia_text_check');
  await rejects('pending cannot carry approval', row({ url, reviewerId: owner, approvedAt: '2099-01-01' }), '23514', 'CmsApprovedMedia_approval_check');
  await rejects('approval requires reviewer/time', row({ status: 'approved', url }), '23514', 'CmsApprovedMedia_approval_check');
  await rejects('dataset FK', row({ datasetId: id(91), objectKey: `${id(91)}/${media}/${hash}.webp` }), '23503', 'CmsApprovedMedia_datasetId_fkey');
  await rejects('creator FK', row({ createdBy: id(92) }), '23503', 'CmsApprovedMedia_createdBy_fkey');
  await sql(row());
  await rejects('native id unique per dataset', row({ id: other, objectKey: otherKey }), '23505', 'CmsApprovedMedia_datasetId_nativeId_key');
  await sql(row({ id: other, datasetId: ds2, objectKey: `${ds2}/${other}/${hash}.webp` }));
  const update = set => `UPDATE "CmsApprovedMedia" SET ${set} WHERE id='${media}'`;
  for (const [name, bad] of [['relative URL', `/assets/${objectKey}`], ['http URL', url.replace('https:', 'http:')],
    ['URL for another key', `https://media.example/assets/${otherKey}`], ['query suffix', `${url}?v=1`], ['credentials', url.replace('https://', 'https://u:p@')]]) {
    await rejects(`url ${name}`, update(`status='approved', url='${bad}', "reviewerId"='${owner}', "approvedAt"=NOW()`), '23514', 'CmsApprovedMedia_url_check');
  }
  await rejects('approval cannot change bytes/hash', update(`status='approved', url='${url}', "reviewerId"='${owner}', "approvedAt"=NOW(), "byteSize"=101`), '23514');
  await rejects('pending cannot be revoked directly', update(`status='revoked'`), '23514');
  await sql(update(`status='approved', url='${url}', "reviewerId"='${owner}', "approvedAt"=NOW()`));
  await rejects('approved metadata immutable', update(`alt='Changed'`), '23514');
  await rejects('approved URL immutable', update(`url='https://other.example/assets/${objectKey}'`), '23514');
  await rejects('approved cannot return to pending', update(`status='pending', url=NULL, "reviewerId"=NULL, "approvedAt"=NULL`), '23514');
  await rejects('revocation cannot rewrite approval evidence', update(`status='revoked', "approvedAt"=NOW() + interval '1 day'`), '23514');
  await sql(update(`status='revoked'`));
  await rejects('revoked is terminal', update(`status='approved'`), '23514');
  await rejects('no delete', `DELETE FROM "CmsApprovedMedia" WHERE id='${media}'`, '23514');
  await rejects('no truncate', 'TRUNCATE "CmsMediaCleanupJob", "CmsApprovedMedia"', '23514');
  const state = await sql(`SELECT status || ':' || "byteSize" || ':' || url FROM "CmsApprovedMedia" WHERE id='${media}'`);
  assert.equal(state, `revoked:100:${url}`);
  console.log(`PASS ${checks} media SQL rejection checks; revoked row and approval evidence preserved`);
}

/** Synthetic rows only: dispatch target/receipt/lease constraints (migration 20261020220000). */
export async function testDispatchSql(sql, { ds, id }) {
  let checks = 0;
  async function rejects(name, statement, state, constraint) {
    await sql(`DO $check$ DECLARE c text; BEGIN BEGIN
      ${statement}; RAISE EXCEPTION 'Unexpected success';
      EXCEPTION WHEN SQLSTATE '${state}' THEN
        GET STACKED DIAGNOSTICS c = CONSTRAINT_NAME;
        ${constraint ? `IF c <> '${constraint}' THEN RAISE EXCEPTION 'Unexpected constraint %', c; END IF;` : ''}
      END; END $check$;`);
    console.log(`PASS dispatch SQL ${++checks}: ${name}`);
  }
  const quote = v => v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replaceAll("'", "''")}'`;
  const insert = (table, v) => `INSERT INTO "${table}" (${Object.keys(v).map(c => `"${c}"`).join(',')},"updatedAt") VALUES (${Object.values(v).map(quote).join(',')},NOW())`;
  const event = await sql(`SELECT id FROM "CmsContentOutbox" WHERE "datasetId"='${ds}' ORDER BY "publicationRevision" LIMIT 1`);
  const target = (o = {}) => insert('CmsDeliveryTarget', { id: id(400), datasetId: ds, consumerId: 'site', url: 'https://site.example/api/content/revalidate', secretEnv: 'CMS_DELIVERY_SECRET_SITE', ...o });
  for (const [name, url] of [['plain HTTP remote', 'http://site.example/api'], ['credentials', 'https://u:p@site.example/api'],
    ['query', 'https://site.example/api?x=1'], ['fragment', 'https://site.example/api#x'], ['missing path', 'https://site.example'], ['HTTP non-loopback IP', 'http://10.0.0.1/api']]) {
    await rejects(`target url ${name}`, target({ url }), '23514', 'CmsDeliveryTarget_url_check');
  }
  await rejects('secretEnv cannot name arbitrary env', target({ secretEnv: 'DATABASE_URL' }), '23514', 'CmsDeliveryTarget_secret_env_check');
  await rejects('secretEnv cannot hold a secret value', target({ secretEnv: 'cms_delivery_secret_' + 'a'.repeat(40) }), '23514', 'CmsDeliveryTarget_secret_env_check');
  await rejects('consumer id shape', target({ consumerId: 'Site One' }), '23514', 'CmsDeliveryTarget_consumer_check');
  await sql(target());
  await sql(target({ id: id(402), consumerId: 'loopback', url: 'http://127.0.0.1:4000/api/content/revalidate' }));
  assert.equal(await sql(`SELECT enabled FROM "CmsDeliveryTarget" WHERE id='${id(400)}'`), 'f');
  await rejects('consumer unique per dataset', target({ id: id(403) }), '23505', 'CmsDeliveryTarget_datasetId_consumerId_key');
  await sql(target({ id: id(401), datasetId: id(90), consumerId: 'other' }));
  const delivery = (o = {}) => insert('CmsContentDelivery', { datasetId: ds, eventId: event, targetId: id(400), ...o });
  await rejects('receipt cannot use another dataset target', delivery({ targetId: id(401) }), '23503', 'CmsContentDelivery_datasetId_targetId_fkey');
  await rejects('receipt cannot use another dataset event', delivery({ datasetId: id(90), targetId: id(401) }), '23503', 'CmsContentDelivery_datasetId_eventId_fkey');
  await rejects('delivered receipt requires timestamp', delivery({ status: 'delivered' }), '23514', 'CmsContentDelivery_delivery_check');
  await rejects('free-text errors refused', delivery({ lastError: 'connect ECONNREFUSED 10.0.0.1' }), '23514', 'CmsContentDelivery_result_check');
  await rejects('status code range', delivery({ lastStatusCode: 42 }), '23514', 'CmsContentDelivery_result_check');
  await sql(delivery());
  await rejects('one receipt per event/target', delivery(), '23505', 'CmsContentDelivery_eventId_targetId_key');
  await rejects('lease token requires lease time', `UPDATE "CmsContentOutbox" SET "leaseToken"=gen_random_uuid() WHERE id='${event}'`, '23514', 'CmsContentOutbox_lease_check');
  await rejects('lease only while processing', `UPDATE "CmsContentOutbox" SET "leaseUntil"=NOW(),"leaseToken"=gen_random_uuid() WHERE id='${event}'`, '23514', 'CmsContentOutbox_lease_check');
  await sql(`DELETE FROM "CmsContentDelivery"; DELETE FROM "CmsDeliveryTarget";`);
  console.log(`PASS ${checks} dispatch SQL rejection checks; synthetic targets/receipts removed`);
}

/** Serialized into the CJS probe (uses its `require`): publish events -> real SQL store ->
 * signed POSTs to a loopback receiver with the mfts-2026 verification -> receipts. */
export async function dispatcherProbe({ db, datasetId, releaseId, root }) {
  const assert = require('node:assert/strict'), http = require('node:http'), path = require('node:path');
  const { createHmac, timingSafeEqual, randomBytes, randomUUID } = require('node:crypto');
  const dispatcher = require(path.join(root, 'apps/web/src/lib/cms/outbox-dispatcher.ts'));
  const secret = randomBytes(32).toString('hex');
  const accepted = [], rejected = [];
  let failNext = 0;
  const server = http.createServer((request, response) => {
    const reply = status => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(status === 200 ? { invalidated: true } : { error: 'Revalidation unavailable.' })); };
    const chunks = []; let size = 0, tooLarge = false;
    request.on('data', chunk => { size += chunk.length; if (size > 16 * 1024) tooLarge = true; else chunks.push(chunk); });
    request.on('end', () => {
      const timestamp = request.headers['x-jongo-timestamp'] ?? '', signature = request.headers['x-jongo-signature'] ?? '';
      const fail = status => { rejected.push(status); reply(status); };
      if (request.method !== 'POST') return fail(405);
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '') || request.headers['content-encoding']) return fail(415);
      if (!/^\d{10}$/.test(timestamp) || !/^v1=[a-f0-9]{64}$/.test(signature) || Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) return fail(401);
      if (tooLarge) return fail(413);
      const body = Buffer.concat(chunks);
      const expected = createHmac('sha256', secret).update(`v1.${timestamp}.`).update(body).digest();
      if (!timingSafeEqual(expected, Buffer.from(signature.slice(3), 'hex'))) return fail(401);
      let record;
      try { record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { return fail(400); }
      if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).sort().join(',') !== 'datasetId,eventId,version' ||
        record.version !== 1 || typeof record.eventId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(record.eventId) || record.datasetId !== datasetId) return fail(400);
      if (failNext > 0) { failNext -= 1; return fail(503); }
      accepted.push(record.eventId); reply(200);
    });
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${server.address().port}/api/content/revalidate`;
  const lines = [], log = line => lines.push(line);
  const store = dispatcher.createPostgresOutboxStore(db);
  const run = (now, extra = {}) => dispatcher.dispatchOutboxOnce(store, { allowLoopbackHttp: true, now: () => now, log, ...extra });
  try {
    process.env.CMS_DELIVERY_SECRET_LOOPBACK = secret;
    delete process.env.CMS_OUTBOX_DISPATCH_ENABLED;
    const events = await db.cmsContentOutbox.findMany({ where: { datasetId }, orderBy: { publicationRevision: 'asc' } });
    assert(events.length >= 1);
    await db.cmsDeliveryTarget.create({ data: { datasetId, consumerId: 'mfts-2026-loopback', url, secretEnv: 'CMS_DELIVERY_SECRET_LOOPBACK', enabled: true } });
    assert.equal((await run(new Date())).enabled, false);
    assert.equal(accepted.length + rejected.length, 0);
    process.env.CMS_OUTBOX_DISPATCH_ENABLED = 'true';
    // First POST answered 503: one event retried with backoff, the rest delivered.
    failNext = 1;
    const t0 = new Date();
    const first = await run(t0);
    assert.deepEqual({ ...first }, { enabled: true, claimed: events.length, delivered: events.length - 1, retried: 1, deadLettered: 0, leaseLost: 0 });
    const retry = await db.cmsContentOutbox.findFirst({ where: { datasetId, status: 'pending' } });
    assert.equal(retry.attempts, 1); assert.equal(retry.leaseToken, null);
    assert.equal(retry.nextAttemptAt.getTime(), t0.getTime() + dispatcher.backoffMs(1));
    const pendingReceipt = await db.cmsContentDelivery.findFirst({ where: { eventId: retry.id } });
    assert.equal(pendingReceipt.status, 'pending'); assert.equal(pendingReceipt.lastStatusCode, 503); assert.equal(pendingReceipt.lastError, 'http_status');
    assert.equal((await run(t0)).claimed, 0);
    // Simulated crashed worker holds a short lease: live lease is skipped, expired lease is reclaimed and the stale token is fenced.
    const t1 = new Date(retry.nextAttemptAt.getTime() + 1);
    const crashedToken = randomUUID();
    const crashed = await store.claim(t1, new Date(t1.getTime() + 1000), crashedToken, 10);
    assert.deepEqual(crashed.map(e => e.id), [retry.id]); assert.equal(crashed[0].attempts, 2);
    assert.equal((await db.cmsContentOutbox.findUnique({ where: { id: retry.id } })).leaseToken, crashedToken);
    assert.equal((await run(new Date(t1.getTime() + 500))).claimed, 0);
    assert.deepEqual({ ...(await run(new Date(t1.getTime() + 2000))) }, { enabled: true, claimed: 1, delivered: 1, retried: 0, deadLettered: 0, leaseLost: 0 });
    assert.equal(await store.finish(crashed[0], crashedToken, { status: 'failed' }, new Date(t1.getTime() + 3000)), false);
    const final = await db.cmsContentOutbox.findMany({ where: { datasetId } });
    assert(final.every(e => e.status === 'delivered' && e.deliveredAt && e.leaseUntil === null && e.leaseToken === null));
    assert.equal((final.find(e => e.id === retry.id)).attempts, 3);
    const receipts = await db.cmsContentDelivery.findMany({ where: { datasetId } });
    assert.equal(receipts.length, events.length);
    assert(receipts.every(r => r.status === 'delivered' && r.deliveredAt && r.lastStatusCode === 200 && r.lastError === null));
    assert.deepEqual([...accepted].sort(), events.map(e => e.id).sort());
    assert.deepEqual(rejected, [503]);
    assert.equal(await db.cmsContentOutbox.count({ where: { NOT: { datasetId }, status: { not: 'pending' } } }), 0);
    // Dead-letter: a second enabled target with no secret configured never sends; event fails at maxAttempts.
    const deadTarget = await db.cmsDeliveryTarget.create({ data: { datasetId, consumerId: 'missing-secret', url: 'https://consumer.example/api/content/revalidate', secretEnv: 'CMS_DELIVERY_SECRET_ABSENT', enabled: true } });
    const synthetic = await db.cmsContentOutbox.create({ data: { datasetId, releaseId, publicationRevision: 9999, eventType: 'release_publish', payload: { synthetic: true } } });
    const dead = await run(new Date(), { maxAttempts: 1 });
    assert.deepEqual({ ...dead }, { enabled: true, claimed: 1, delivered: 0, retried: 0, deadLettered: 1, leaseLost: 0 });
    assert.equal((await db.cmsContentOutbox.findUnique({ where: { id: synthetic.id } })).status, 'failed');
    const deadReceipts = await db.cmsContentDelivery.findMany({ where: { eventId: synthetic.id }, orderBy: { status: 'asc' } });
    assert.deepEqual(deadReceipts.map(r => `${r.targetId === deadTarget.id ? 'missing' : 'loopback'}:${r.status}:${r.lastError}`).sort(),
      ['loopback:delivered:null', 'missing:dead:secret_unavailable']);
    assert.equal(accepted.at(-1), synthetic.id);
    assert.equal((await run(new Date(Date.now() + 86400000))).claimed, 0);
    await db.cmsDeliveryTarget.updateMany({ where: { datasetId }, data: { enabled: false } });
    const output = lines.join('\n');
    assert.match(output, /consumer=mfts-2026-loopback delivered status=200/);
    assert.doesNotMatch(output, new RegExp([secret, '127\\.0\\.0\\.1', 'revalidate', 'consumer\\.example', '"version"', 'CMS_DELIVERY_SECRET'].join('|')));
    console.log(`PASS real outbox dispatch: ${events.length} lifecycle events signed+POSTed to loopback HMAC receiver, 503 backoff, live-lease skip, expired-lease reclaim, stale-token fencing, per-target delivered receipts, missing-secret dead-letter, redacted logs`);
  } finally {
    delete process.env.CMS_OUTBOX_DISPATCH_ENABLED; delete process.env.CMS_DELIVERY_SECRET_LOOPBACK;
    await new Promise(ok => server.close(ok));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = spawnSync(process.execPath, [resolve(dirname(fileURLToPath(import.meta.url)), 'test-cms-delivery.mjs'), ...process.argv.slice(2)], { stdio: 'inherit', shell: false });
  process.exitCode = result.status ?? 1;
}