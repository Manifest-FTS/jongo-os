import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import {
  canonicalJson, createDataset, discardDraft, getDocument, listDocuments, publishDocument, saveDraft, sha256Hex, unpublishDocument
} from '../../dist/server/index.js';
import { count, expectError, freshDb, key, makeCtx, page, person, registry, spyExecutor } from './helpers.mjs';

let db, ctx;
before(async () => { db = await freshDb('docs'); ctx = makeCtx(db); await createDataset(ctx, { name: 'production' }); await createDataset(ctx, { name: 'staging' }); });
after(() => db.close());

const save = (input, extra = {}) => saveDraft(ctx, { dataset: 'production', registry, input, mutationKey: key(), ...extra });
const ref = id => ({ _type: 'reference', _ref: id });
const get = (id, perspective = 'published', consumer = 'editor', dataset = 'production') => getDocument(ctx, { dataset, registry, documentId: id, perspective, consumer });
const publish = (id, expected, extra = {}) => publishDocument(ctx, { dataset: 'production', registry, documentId: id, mutationKey: key(), ...expected, ...extra });

test('saveDraft stores a validated draft: rows, canonical hash, receipt and a content-free audit entry', async () => {
  await save(person('ada'));
  const input = page('home', { author: ref('ada'), internalNote: 'TOP-SECRET-NOTE', slug: { _type: 'slug', current: 'home' } });
  const result = await save(input);
  assert.deepEqual({ ...result, nativeRev: 'x' }, { documentId: 'drafts.home', logicalId: 'home', type: 'page', variant: 'draft', nativeRev: 'x', lockVersion: 1, sequence: 1, replayed: false });
  const doc = (await db.sql(`SELECT * FROM craft.documents WHERE native_id = 'drafts.home'`)).rows[0];
  assert.equal(doc.variant, 'draft'); assert.equal(doc.logical_id, 'home'); assert.equal(doc.archived_at, null);
  const rev = (await db.sql(`SELECT * FROM craft.revisions WHERE id = $1`, [doc.current_revision_id])).rows[0];
  const { _id, _type, ...body } = input;
  assert.deepEqual(rev.payload, body);
  assert.equal(rev.payload_sha256, sha256Hex(canonicalJson(body)));
  assert.equal(rev.schema_version, 2); assert.equal(rev.actor_id, 'alice'); assert.equal(rev.native_rev, result.nativeRev);
  assert.equal(await count(db, 'mutations', `operation = 'saveDraft' AND key = $1`, [(await db.sql(`SELECT key FROM craft.mutations ORDER BY created_at DESC LIMIT 1`)).rows[0].key]), 1);
  const audit = (await db.sql(`SELECT * FROM craft.audit_log WHERE action = 'document.save' AND document_id = $1`, [doc.id])).rows[0];
  assert.equal(audit.actor_id, 'alice');
  assert.ok(!JSON.stringify(audit.detail).includes('TOP-SECRET-NOTE') && !JSON.stringify(audit.detail).includes('Title home'), 'audit detail has no content');
  assert.deepEqual((await db.sql(`SELECT path, target_native_id, weak FROM craft."references" WHERE revision_id = $1`, [rev.id])).rows, [{ path: 'author', target_native_id: 'ada', weak: false }]);
  const read = await get('home', 'previewDrafts');
  assert.equal(read.document._id, 'home'); assert.equal(read.document._rev, result.nativeRev); assert.equal(read.variant, 'draft');
  assert.match(read.document._createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('server-side validation rejects invalid documents, writes nothing and never echoes content', async () => {
  const before = await count(db, 'documents');
  const secret = 'SECRETVALUE'.repeat(20);
  const error = await expectError(save(page('bad', { title: secret })), 'validation_failed');
  assert.deepEqual(error.issues.map(i => [i.path.join('.'), i.code]), [['title', 'length']]);
  assert.ok(!JSON.stringify(error.issues).includes('SECRETVALUE') && !error.message.includes('SECRETVALUE'));
  await expectError(save({ _id: 'bad2', _type: 'page' }), 'validation_failed'); // required title
  await expectError(save(page('bad3', { author: ref('nobody') })), 'validation_failed'); // missing strong reference
  await expectError(save(page('bad4', { author: ref('drafts.ada') })), 'validation_failed');
  await expectError(save(page('bad5', { hero: { _type: 'image', asset: ref('image-1') } })), 'validation_failed'); // no asset known
  const ok = await save(page('with-asset', { hero: { _type: 'image', asset: ref('image-1') } }), { assets: [{ _id: 'image-1', _type: 'sanity.imageAsset' }] });
  assert.equal(ok.sequence, 1);
  assert.equal(await count(db, 'documents'), before + 1);
  assert.equal(await count(db, 'documents', `logical_id IN ('bad','bad2','bad3','bad4','bad5')`), 0);
});

test('drafts may omit publishRequired fields; publishing may not', async () => {
  const saved = await save({ _id: 'needs-summary', _type: 'page', title: 'T' });
  const error = await expectError(publish('needs-summary', { expectedNativeRev: saved.nativeRev }), 'validation_failed');
  assert.deepEqual(error.issues.map(i => i.code), ['publish_required']);
  assert.equal(await count(db, 'documents', `logical_id = 'needs-summary' AND variant = 'published'`), 0);
  const fixed = await save({ _id: 'needs-summary', _type: 'page', title: 'T', summary: 'S' }, { expectedNativeRev: saved.nativeRev });
  const published = await publish('needs-summary', { expectedNativeRev: fixed.nativeRev });
  assert.equal(published.variant, 'published');
});

test('unknown types, unsafe or oversized content and bad ids are rejected with typed errors', async () => {
  await expectError(save({ _id: 'x', _type: 'nope', title: 'x' }), 'unknown_type');
  await expectError(save(null), 'invalid_document');
  await expectError(save([]), 'invalid_document');
  await expectError(save(JSON.parse('{"_id":"u1","_type":"page","title":"x","__proto__":{"a":1}}')), 'unsafe_content');
  await expectError(save(page('u2', { meta: { label: 'x', nested: JSON.parse('{"constructor":1}') } })), 'unsafe_content');
  await expectError(save(page('u3', { title: 'a\u0000b' })), 'unsafe_content');
  await expectError(save(page('u4', { title: 'a\ud800b' })), 'unsafe_content');
  await expectError(save(page('u5', { [`k\u0000`]: 1 })), 'unsafe_content');
  await expectError(save(page('u6', { blocks: [{ text: 'x'.repeat(100_000) }, { text: 'y'.repeat(100_000) }, { text: 'z'.repeat(100_000) }, { text: 'w'.repeat(100_000) }, { text: 'v'.repeat(100_000) }, { text: 'u'.repeat(100_000) }] })), 'limit_exceeded');
  await expectError(save(page('u7', { meta: { label: new Date() } })), 'invalid_document');
  await expectError(save(page('u8', { meta: { label: undefined } })), 'invalid_document');
  await expectError(save(page('u9', { title: Infinity })), 'invalid_document');
  const deep = {}; let at = deep; for (let i = 0; i < 40; i++) at = at.n = {};
  await expectError(save(page('u10', { meta: deep })), 'limit_exceeded');
  for (const id of ['has space', '../x', 'versions.x', '-x', 'drafts.', 'a'.repeat(129), '']) await expectError(save(page('ok'), { documentId: id }), 'invalid_input');
  await expectError(save(page('one'), { documentId: 'two' }), 'invalid_input');
  assert.equal(await count(db, 'documents', `logical_id LIKE 'u%'`), 0);
});

test('a generated id is used when none is supplied, and the type of an id cannot change', async () => {
  const created = await save({ _type: 'person', name: 'No Id' });
  assert.match(created.logicalId, /^[0-9a-f-]{36}$/);
  assert.equal(created.documentId, `drafts.${created.logicalId}`);
  const clash = save({ _id: created.logicalId, _type: 'page', title: 'x' }, { expectedNativeRev: created.nativeRev });
  await expectError(clash, 'conflict');
});

test('compare-and-set: expectations are required for existing documents and must match', async () => {
  const a = await save(page('cas'));
  await expectError(save(page('cas', { title: 'no expectation' })), 'precondition_required');
  await expectError(save(page('cas', { title: 'stale' }), { expectedNativeRev: 'stale' }), 'conflict');
  await expectError(save(page('cas', { title: 'stale lock' }), { expectedLockVersion: 7 }), 'conflict');
  await expectError(save(page('cas', { title: 'mixed' }), { expectedNativeRev: a.nativeRev, expectedLockVersion: 9 }), 'conflict');
  await expectError(save(page('cas-new'), { expectedNativeRev: 'something' }), 'conflict');
  await expectError(save(page('cas-new'), { expectedLockVersion: 3 }), 'conflict');
  await expectError(save(page('cas'), { expectedLockVersion: -1 }), 'invalid_input');
  await expectError(save(page('cas'), { expectedLockVersion: 1.5 }), 'invalid_input');
  const b = await save(page('cas', { title: 'second' }), { expectedNativeRev: a.nativeRev, expectedLockVersion: a.lockVersion });
  assert.equal(b.lockVersion, 2); assert.equal(b.sequence, 2); assert.notEqual(b.nativeRev, a.nativeRev);
  await expectError(save(page('cas', { title: 'replay old rev' }), { expectedNativeRev: a.nativeRev }), 'conflict');
  const c = await save(page('cas', { title: 'third' }), { expectedLockVersion: b.lockVersion });
  assert.equal(c.sequence, 3);
  assert.equal((await save(page('cas-zero'), { expectedLockVersion: 0 })).lockVersion, 1);
  // Revisions are history: all three remain.
  assert.equal(await count(db, 'revisions', `document_id = (SELECT id FROM craft.documents WHERE native_id = 'drafts.cas')`), 3);
  assert.equal((await get('cas', 'previewDrafts')).document.title, 'third');
});

test('idempotency: same key+request replays the receipt; a different request, actor or operation conflicts', async () => {
  const k = key('idem');
  const input = page('idem');
  const first = await save(input, { mutationKey: k });
  const again = await save(input, { mutationKey: k });
  assert.equal(again.replayed, true);
  assert.deepEqual({ ...again, replayed: false }, first);
  assert.equal(await count(db, 'revisions', `document_id = (SELECT id FROM craft.documents WHERE native_id = 'drafts.idem')`), 1);
  await expectError(save(page('idem', { title: 'different body' }), { mutationKey: k }), 'idempotency_conflict');
  await expectError(save(input, { mutationKey: k, expectedLockVersion: 1 }), 'idempotency_conflict');
  await expectError(saveDraft(makeCtx(db, { actorId: 'mallory' }), { dataset: 'production', registry, input, mutationKey: k }), 'idempotency_conflict');
  await expectError(publish('idem', { expectedNativeRev: first.nativeRev }, { mutationKey: k }), 'idempotency_conflict');
  // A replay survives later changes to the document: it returns the original result.
  await save(page('idem', { title: 'later' }), { expectedNativeRev: first.nativeRev });
  assert.deepEqual({ ...(await save(input, { mutationKey: k })), replayed: false }, first);
  // Keys are per dataset.
  const other = await saveDraft(ctx, { dataset: 'staging', registry, input, mutationKey: k });
  assert.equal(other.replayed, false);
  // Create without an id replays to the same generated document.
  const k2 = key('noid');
  const created = await save({ _type: 'person', name: 'Replay' }, { mutationKey: k2 });
  const replay = await save({ _type: 'person', name: 'Replay' }, { mutationKey: k2 });
  assert.equal(replay.logicalId, created.logicalId); assert.equal(replay.replayed, true);
});

test('publish, unpublish and discard lifecycle (publish archives the draft; nothing is hard-deleted)', async () => {
  const d1 = await save(page('life', { title: 'v1' }));
  const p1 = await publish('life', { expectedNativeRev: d1.nativeRev });
  assert.deepEqual({ documentId: p1.documentId, variant: p1.variant, sequence: p1.sequence, lockVersion: p1.lockVersion }, { documentId: 'life', variant: 'published', sequence: 1, lockVersion: 1 });
  const rows = (await db.sql(`SELECT native_id, variant, archived_at IS NOT NULL AS archived FROM craft.documents WHERE logical_id = 'life' ORDER BY variant`)).rows;
  assert.deepEqual(rows, [{ native_id: 'drafts.life', variant: 'draft', archived: true }, { native_id: 'life', variant: 'published', archived: false }]);
  assert.equal((await get('life', 'published')).document.title, 'v1');
  const preview = await get('life', 'previewDrafts');
  assert.equal(preview.variant, 'published'); assert.equal(preview.nativeRev, p1.nativeRev);
  assert.equal((await get('drafts.life', 'raw')), null, 'the archived draft is not live');
  assert.equal((await get('life', 'raw')).document._id, 'life');
  // The published payload is a byte-identical copy of the draft payload.
  assert.equal((await db.sql(`SELECT count(DISTINCT payload_sha256)::int AS n FROM craft.revisions WHERE document_id IN (SELECT id FROM craft.documents WHERE logical_id = 'life')`)).rows[0].n, 1);

  // Editing a published document starts a new draft whose base is the published revision.
  await expectError(save(page('life', { title: 'v2' })), 'precondition_required');
  const d2 = await save(page('life', { title: 'v2' }), { expectedNativeRev: p1.nativeRev });
  assert.equal(d2.variant, 'draft'); assert.equal(d2.sequence, 2);
  assert.equal((await get('life', 'published')).document.title, 'v1');
  assert.equal((await get('life', 'previewDrafts')).document.title, 'v2');
  // Discard returns to the published version.
  await expectError(discardDraft(ctx, { dataset: 'production', registry, documentId: 'life', mutationKey: key() }), 'precondition_required');
  await expectError(discardDraft(ctx, { dataset: 'production', registry, documentId: 'life', mutationKey: key(), expectedNativeRev: p1.nativeRev }), 'conflict');
  const discarded = await discardDraft(ctx, { dataset: 'production', registry, documentId: 'drafts.life', mutationKey: key(), expectedNativeRev: d2.nativeRev });
  assert.equal(discarded.variant, 'published'); assert.equal(discarded.nativeRev, p1.nativeRev);
  assert.equal((await get('life', 'previewDrafts')).document.title, 'v1');
  await expectError(discardDraft(ctx, { dataset: 'production', registry, documentId: 'life', mutationKey: key(), expectedNativeRev: d2.nativeRev }), 'not_found');

  // Publish again from a fresh draft: second published revision, history kept.
  const d3 = await save(page('life', { title: 'v3' }), { expectedNativeRev: p1.nativeRev });
  await expectError(publish('life', { expectedNativeRev: d2.nativeRev }), 'conflict');
  await expectError(publish('life', {}), 'precondition_required');
  const p2 = await publish('life', { expectedLockVersion: d3.lockVersion });
  assert.equal(p2.sequence, 2); assert.equal((await get('life', 'published')).document.title, 'v3');
  assert.equal(await count(db, 'revisions', `document_id = (SELECT id FROM craft.documents WHERE native_id = 'life')`), 2);
  await expectError(publish('life', { expectedNativeRev: p2.nativeRev }), 'not_found'); // no live draft any more

  // Unpublish restores a draft from the published payload and archives the published row.
  const up = await unpublishDocument(ctx, { dataset: 'production', registry, documentId: 'life', mutationKey: key(), expectedNativeRev: p2.nativeRev });
  assert.equal(up.variant, 'draft'); assert.equal(up.documentId, 'drafts.life');
  assert.equal(await get('life', 'published'), null);
  assert.equal((await get('life', 'previewDrafts')).document.title, 'v3');
  assert.equal(await discardDraftOrNull('life'), 'conflict', 'cannot discard when nothing is published');
  // Republish works, and unpublish keeps an existing live draft's edits untouched.
  const p3 = await publish('life', { expectedNativeRev: up.nativeRev });
  const d4 = await save(page('life', { title: 'v4 in progress' }), { expectedNativeRev: p3.nativeRev });
  const up2 = await unpublishDocument(ctx, { dataset: 'production', registry, documentId: 'life', mutationKey: key(), expectedNativeRev: p3.nativeRev });
  assert.equal(up2.nativeRev, d4.nativeRev);
  assert.equal((await get('life', 'previewDrafts')).document.title, 'v4 in progress');
  assert.equal(await get('life', 'published'), null);
  assert.equal(await count(db, 'documents', `logical_id = 'life'`), 2);
  assert.ok(await count(db, 'audit_log', `action IN ('document.publish','document.unpublish','document.discard')`) >= 6);
});
async function discardDraftOrNull(id) {
  try { await discardDraft(ctx, { dataset: 'production', registry, documentId: id, mutationKey: key(), expectedNativeRev: (await get(id, 'previewDrafts')).nativeRev }); return 'ok'; } catch (e) { return e.code; }
}

test('lifecycle operations on missing documents and wrong states', async () => {
  await expectError(publish('ghost', { expectedLockVersion: 1 }), 'not_found');
  await expectError(unpublishDocument(ctx, { dataset: 'production', registry, documentId: 'ghost', mutationKey: key(), expectedLockVersion: 1 }), 'not_found');
  await expectError(discardDraft(ctx, { dataset: 'production', registry, documentId: 'ghost', mutationKey: key(), expectedLockVersion: 1 }), 'not_found');
  const d = await save(page('only-draft'));
  await expectError(unpublishDocument(ctx, { dataset: 'production', registry, documentId: 'only-draft', mutationKey: key(), expectedLockVersion: 1 }), 'not_found');
  await expectError(discardDraft(ctx, { dataset: 'production', registry, documentId: 'only-draft', mutationKey: key(), expectedNativeRev: d.nativeRev }), 'conflict');
  assert.equal((await get('only-draft', 'previewDrafts')).document.title, 'Title only-draft', 'nothing was lost');
});

test('listDocuments: metadata only, keyset pagination, type filter, perspectives and dataset isolation', async () => {
  const lister = await freshDb('list');
  try {
    const lctx = makeCtx(lister);
    await createDataset(lctx, { name: 'production' }); await createDataset(lctx, { name: 'staging' });
    for (const id of ['a', 'b', 'c', 'd', 'e']) await saveDraft(lctx, { dataset: 'production', registry, input: page(id), mutationKey: key() });
    await saveDraft(lctx, { dataset: 'production', registry, input: person('zed'), mutationKey: key() });
    await saveDraft(lctx, { dataset: 'staging', registry, input: page('only-staging'), mutationKey: key() });
    const list = options => listDocuments(lctx, { dataset: 'production', ...options });
    assert.deepEqual((await list({})).items, [], 'published perspective: nothing published yet');
    const first = await list({ perspective: 'previewDrafts', limit: 2 });
    assert.deepEqual(first.items.map(i => i.id), ['a', 'b']);
    assert.ok(first.nextCursor);
    const second = await list({ perspective: 'previewDrafts', limit: 2, cursor: first.nextCursor });
    const third = await list({ perspective: 'previewDrafts', limit: 2, cursor: second.nextCursor });
    assert.deepEqual([...second.items, ...third.items].map(i => i.id), ['c', 'd', 'e', 'zed']);
    assert.equal(third.nextCursor, null);
    assert.deepEqual((await list({ perspective: 'previewDrafts', type: 'person' })).items.map(i => i.id), ['zed']);
    for (const item of first.items) assert.deepEqual(Object.keys(item).sort(), ['id', 'lockVersion', 'nativeId', 'nativeRev', 'type', 'updatedAt', 'variant']);
    const raw = await list({ perspective: 'raw' });
    assert.ok(raw.items.every(i => i.id.startsWith('drafts.') && i.variant === 'draft'));
    // A published document with a newer draft appears once under previewDrafts (the draft), twice under raw.
    const d = (await getDocument(lctx, { dataset: 'production', registry, documentId: 'a', perspective: 'previewDrafts', consumer: 'editor' }));
    const pub = await publishDocument(lctx, { dataset: 'production', registry, documentId: 'a', mutationKey: key(), expectedNativeRev: d.nativeRev });
    await saveDraft(lctx, { dataset: 'production', registry, input: page('a', { title: 'newer' }), mutationKey: key(), expectedNativeRev: pub.nativeRev });
    assert.deepEqual((await list({ perspective: 'previewDrafts', limit: 1 })).items.map(i => [i.id, i.variant]), [['a', 'draft']]);
    assert.deepEqual((await list({ perspective: 'raw', limit: 3 })).items.map(i => i.nativeId), ['a', 'drafts.a', 'drafts.b']);
    assert.deepEqual((await list({ perspective: 'published' })).items.map(i => i.id), ['a']);
    for (const bad of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { cursor: '!!!' }, { cursor: 'x'.repeat(500) }, { type: 'bad type' }]) await expectError(list(bad), 'invalid_input');
  } finally { await lister.close(); }
});

test('getDocument: perspectives, consumers, drafts prefix handling and invalid ids', async () => {
  await save(person('priv-person'));
  await save(page('view', { internalNote: 'hidden', meta: { label: 'shown', internalCode: 'hidden2' } }));
  const publicView = await get('view', 'previewDrafts', 'public');
  assert.equal(publicView.document.internalNote, undefined); assert.equal(publicView.document.meta.internalCode, undefined); assert.equal(publicView.document.meta.label, 'shown');
  const editorView = await get('drafts.view', 'previewDrafts', 'editor');
  assert.equal(editorView.document.internalNote, 'hidden');
  assert.equal((await get('view', 'raw', 'editor')), null, 'raw needs the exact native id');
  assert.equal((await get('drafts.view', 'raw', 'editor')).document._id, 'drafts.view');
  assert.equal(await get('nothing', 'previewDrafts'), null);
  await expectError(get('bad id'), 'invalid_input');
  await expectError(getDocument(ctx, { dataset: 'production', registry, documentId: 'view', perspective: 'weird' }), 'invalid_perspective');
  await expectError(getDocument(ctx, { dataset: 'production', registry, documentId: 'view', consumer: 'admin' }), 'invalid_options');
});

test('failures leave nothing behind and surface only fixed messages (no SQL, no driver text, no content)', async () => {
  const before = { documents: await count(db, 'documents'), revisions: await count(db, 'revisions'), mutations: await count(db, 'mutations'), audit: await count(db, 'audit_log') };
  for (const failOn of [/INSERT INTO craft\.revisions/, /UPDATE craft\.documents/, /INSERT INTO craft\.mutations/, /INSERT INTO craft\.audit_log/]) {
    const spy = spyExecutor(db.executor, { failOn });
    const error = await expectError(saveDraft(makeCtx(db, { executor: spy }), { dataset: 'production', registry, input: page('atomic', { title: 'CONTENT-MARKER' }), mutationKey: key() }), 'unavailable');
    assert.ok(!/SECRET_SQL|INSERT|UPDATE|CONTENT-MARKER|craft\./i.test(error.message), error.message);
    assert.equal(error.cause, undefined);
  }
  assert.deepEqual({ documents: await count(db, 'documents'), revisions: await count(db, 'revisions'), mutations: await count(db, 'mutations'), audit: await count(db, 'audit_log') }, before);
});

test('serialization failures and deadlocks are retried up to three attempts', async () => {
  for (const code of ['40001', '40P01']) {
    const spy = spyExecutor(db.executor, { failTransactions: 2, failCode: code });
    const result = await saveDraft(makeCtx(db, { executor: spy }), { dataset: 'production', registry, input: page(`retry-${code}`), mutationKey: key() });
    assert.equal(result.sequence, 1); assert.equal(spy.transactions, 3);
  }
  const hopeless = spyExecutor(db.executor, { failTransactions: 3 });
  await expectError(saveDraft(makeCtx(db, { executor: hopeless }), { dataset: 'production', registry, input: page('retry-fail'), mutationKey: key() }), 'unavailable');
  assert.equal(hopeless.transactions, 3);
  assert.equal(await count(db, 'documents', `logical_id = 'retry-fail'`), 0);
});

test('bounded identifiers: mutation keys, actor ids, dataset names; unknown datasets are not_found', async () => {
  for (const bad of ['', 'has space', 'x'.repeat(129), 'new\nline', undefined, 5]) await expectError(save(page('k1'), { mutationKey: bad }), 'invalid_input');
  for (const actorId of ['', 'x'.repeat(129), 'a\u0000b', 5, null]) await expectError(saveDraft(makeCtx(db, { actorId }), { dataset: 'production', registry, input: page('k2'), mutationKey: key() }), 'invalid_input');
  for (const dataset of ['', 'Upper', 'a b', 'x'.repeat(65), "x'; DROP TABLE craft.documents; --", undefined]) await expectError(save(page('k3'), { dataset }), 'invalid_input');
  await expectError(save(page('k4'), { dataset: 'missing' }), 'not_found');
  assert.equal(await count(db, 'documents', `logical_id LIKE 'k%'`), 0);
});

test('datasets are isolated: same ids in two datasets are independent', async () => {
  await saveDraft(ctx, { dataset: 'staging', registry, input: page('iso', { title: 'staging copy' }), mutationKey: key() });
  await save(page('iso', { title: 'production copy' }));
  assert.equal((await get('iso', 'previewDrafts', 'editor', 'staging')).document.title, 'staging copy');
  assert.equal((await get('iso', 'previewDrafts', 'editor', 'production')).document.title, 'production copy');
});
