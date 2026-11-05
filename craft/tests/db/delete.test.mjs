import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { createDataset, deleteDocument, exportNdjson, getDocument, getDocumentHistory, listDocuments, publishDocument, queryDataset, saveDraft, unpublishDocument } from '../../dist/server/index.js';
import { allow, count, expectError, freshDb, key, makeCtx, page, person, registry } from './helpers.mjs';

let db, ctx;
before(async () => { db = await freshDb('delete'); ctx = makeCtx(db); await createDataset(ctx, { name: 'production' }); });
after(() => db.close());

const D = { dataset: 'production', registry };
const save = (input, extra = {}, c = ctx) => saveDraft(c, { ...D, input, mutationKey: key(), ...extra });
const publish = (id, expected, c = ctx) => publishDocument(c, { ...D, documentId: id, mutationKey: key(), ...expected });
const remove = (id, expected, extra = {}, c = ctx) => deleteDocument(c, { dataset: 'production', documentId: id, mutationKey: key(), ...expected, ...extra });
const get = (id, perspective = 'published', consumer = 'editor') => getDocument(ctx, { ...D, documentId: id, perspective, consumer });
const rev = r => ({ expectedNativeRev: r.nativeRev });
const published = async (input) => { const d = await save(input); return publish(input._id, rev(d)); };

test('delete soft-archives draft and published, keeps every revision, and the id disappears from get, list, query and export', async () => {
  const p = await published(page('gone'));
  const draft = await save(page('gone', { title: 'Edited after publish' }), { expectedNativeRev: p.nativeRev });
  assert.equal(draft.variant, 'draft');
  const revisionsBefore = await count(db, 'revisions');
  const result = await remove('gone', rev(draft));
  assert.deepEqual({ ...result }, { logicalId: 'gone', type: 'page', variants: ['draft', 'published'], replayed: false });
  // Soft-archived, never hard-deleted: both rows and all revisions remain.
  assert.equal(await count(db, 'documents', `logical_id = 'gone' AND archived_at IS NOT NULL`), 2);
  assert.equal(await count(db, 'documents', `logical_id = 'gone' AND archived_at IS NULL`), 0);
  assert.equal(await count(db, 'revisions'), revisionsBefore);
  // Nothing reads it any more, in any perspective or consumer.
  for (const perspective of ['published', 'previewDrafts', 'raw']) assert.equal(await get('gone', perspective), null, perspective);
  assert.equal(await get('drafts.gone', 'raw'), null);
  for (const perspective of ['published', 'previewDrafts', 'raw']) assert.ok(!(await listDocuments(ctx, { dataset: 'production', perspective })).items.some(item => item.id.replace('drafts.', '') === 'gone'), `list ${perspective}`);
  for (const perspective of ['published', 'previewDrafts', 'raw']) assert.deepEqual((await queryDataset(ctx, { ...D, query: '*[_id in ["gone", "drafts.gone"]]._id', perspective })).result, [], `query ${perspective}`);
  for (const perspective of ['published', 'raw']) assert.ok(!Buffer.from((await exportNdjson(ctx, { ...D, perspective })).bytes).toString('utf8').includes('"gone"'), `export ${perspective}`);
  // Audit: one row, by the actor, with identifiers only.
  const audit = (await db.sql(`SELECT * FROM craft.audit_log WHERE action = 'document.delete'`)).rows;
  assert.equal(audit.length, 1); assert.equal(audit[0].actor_id, 'alice');
  assert.deepEqual(audit[0].detail, { documentId: 'gone', type: 'page', variants: ['draft', 'published'] });
  assert.ok(!JSON.stringify(audit[0].detail).includes('Edited after publish'));
});

test('a draft-only and a published-only document can be deleted; unknown and already-deleted ids are not_found', async () => {
  const onlyDraft = await save(page('only-draft'));
  assert.deepEqual((await remove('only-draft', rev(onlyDraft))).variants, ['draft']);
  const p = await published(page('only-pub'));
  assert.deepEqual((await remove('only-pub', rev(p))).variants, ['published']);
  await expectError(remove('only-pub', rev(p)), 'not_found'); // new key, already deleted
  await expectError(remove('never-existed', { expectedLockVersion: 1 }), 'not_found');
});

test('compare-and-set: a stale revision conflicts, an expectation is required, and nothing changes on failure', async () => {
  const p = await published(page('cas'));
  const next = await save(page('cas', { title: 'Newer' }), { expectedNativeRev: p.nativeRev });
  const before = [await count(db, 'documents', `archived_at IS NULL`), await count(db, 'audit_log', `action = 'document.delete'`)];
  await expectError(remove('cas', rev(p)), 'conflict'); // the head is now the newer draft
  await expectError(remove('cas', { expectedLockVersion: next.lockVersion + 5 }), 'conflict');
  await expectError(remove('cas', {}), 'precondition_required');
  await expectError(remove('cas', { expectedNativeRev: '' }), 'invalid_input');
  await expectError(remove('bad id', rev(p)), 'invalid_input');
  await expectError(deleteDocument(ctx, { dataset: 'production', documentId: 'cas', mutationKey: 'bad key with spaces', ...rev(next) }), 'invalid_input');
  assert.deepEqual([await count(db, 'documents', `archived_at IS NULL`), await count(db, 'audit_log', `action = 'document.delete'`)], before);
  assert.ok(await get('cas', 'previewDrafts'));
  // Lock version alone is enough too.
  assert.equal((await remove('cas', { expectedLockVersion: next.lockVersion })).logicalId, 'cas');
});

test('idempotent: the same key and request replays the first outcome; the same key for another request is refused', async () => {
  const d = await save(page('idem'));
  const k = key('delete');
  const first = await remove('idem', rev(d), { mutationKey: k });
  const again = await remove('idem', rev(d), { mutationKey: k });
  assert.equal(first.replayed, false); assert.equal(again.replayed, true);
  assert.deepEqual({ ...again, replayed: false }, first);
  assert.equal(await count(db, 'audit_log', `action = 'document.delete' AND detail->>'documentId' = 'idem'`), 1);
  const other = await save(page('idem-other'));
  await expectError(remove('idem-other', rev(other), { mutationKey: k }), 'idempotency_conflict');
  assert.ok(await get('idem-other', 'previewDrafts'), 'the refused request deleted nothing');
  // Concurrent duplicates: one effect, the rest replay.
  const c = await save(page('idem-race'));
  const k2 = key('race');
  const results = await Promise.all([1, 2, 3].map(() => remove('idem-race', rev(c), { mutationKey: k2 })));
  assert.equal(results.filter(r => !r.replayed).length, 1);
  assert.equal(await count(db, 'audit_log', `action = 'document.delete' AND detail->>'documentId' = 'idem-race'`), 1);
});

test('authorization: both write and publish are required; denial changes nothing', async () => {
  const d = await save(page('authz-del'));
  for (const only of [['write'], ['publish'], ['read', 'read-drafts'], []]) {
    const c = makeCtx(db, { authorize: async (_a, action) => only.includes(action) });
    await expectError(remove('authz-del', rev(d), {}, c), 'denied');
  }
  assert.equal(await count(db, 'documents', `logical_id = 'authz-del' AND archived_at IS NULL`), 1);
  assert.equal(await count(db, 'audit_log', `action = 'document.delete' AND detail->>'documentId' = 'authz-del'`), 0);
  assert.equal((await remove('authz-del', rev(d), {}, makeCtx(db, { authorize: allow('write', 'publish') }))).logicalId, 'authz-del');
});

test('referenced-by: a live strong reference blocks the delete; weak references and self references do not; deleting the referrer first unblocks', async () => {
  await save(person('ada'));
  const ada = await get('ada', 'previewDrafts');
  await save(page('essay', { author: { _type: 'reference', _ref: 'ada' } }));
  await expectError(remove('ada', { expectedNativeRev: ada.nativeRev }), 'referenced');
  assert.ok(await get('ada', 'previewDrafts'), 'still live');
  assert.equal(await count(db, 'audit_log', `action = 'document.delete' AND detail->>'documentId' = 'ada'`), 0);
  // Weak reference: deleting the target is allowed.
  const target = await save(page('weak-target'));
  await save(page('weak-source', { related: [{ _type: 'reference', _key: 'a', _ref: 'weak-target', _weak: true }] }));
  assert.equal((await remove('weak-target', rev(target))).logicalId, 'weak-target');
  // The referrer's own delete is unblocked, then the person can go.
  const essay = await get('essay', 'previewDrafts');
  await remove('essay', rev(essay));
  assert.equal((await remove('ada', { expectedNativeRev: ada.nativeRev })).logicalId, 'ada');
  // Published referrers count too.
  const bob = await save(person('bob'));
  const writer = await published(page('published-essay', { author: { _type: 'reference', _ref: 'bob' } }));
  await expectError(remove('bob', rev(bob)), 'referenced');
  await unpublishDocument(ctx, { ...D, documentId: 'published-essay', mutationKey: key(), ...rev(writer) });
  await expectError(remove('bob', rev(bob)), 'referenced'); // the unpublished draft still references it
});

test('published delivery no longer returns a deleted document, but other documents are unaffected', async () => {
  const keep = await published(page('keep'));
  const drop = await published(page('drop'));
  assert.ok(await getDocument(ctx, { ...D, documentId: 'drop' }));
  await remove('drop', rev(drop));
  const reader = makeCtx(db, { authorize: allow('read') });
  assert.equal(await getDocument(reader, { ...D, documentId: 'drop' }), null);
  assert.equal((await getDocument(reader, { ...D, documentId: 'keep' })).document._id, 'keep');
  assert.ok(!(await listDocuments(reader, { dataset: 'production' })).items.some(item => item.id === 'drop'));
  assert.ok((await listDocuments(reader, { dataset: 'production' })).items.some(item => item.id === keep.logicalId));
  assert.deepEqual((await queryDataset(reader, { ...D, query: '*[_id == "drop"]' })).result, []);
});

test('re-creating a deleted id is allowed as a fresh document of the same type; stale writers cannot revive the old one', async () => {
  const p = await published(page('phoenix', { title: 'Old life' }));
  await remove('phoenix', rev(p));
  await expectError(save(page('phoenix'), rev(p)), 'conflict'); // a stale tab cannot resurrect it
  await expectError(save({ _id: 'phoenix', _type: 'person', name: 'Other type' }), 'conflict'); // the id stays bound to its type
  const reborn = await save(page('phoenix', { title: 'New life' }));
  assert.equal(reborn.variant, 'draft'); assert.ok(reborn.sequence > 1, 'the revision log continues');
  assert.equal(await get('phoenix', 'published'), null, 'nothing published from the old life');
  const head = await get('phoenix', 'previewDrafts');
  assert.equal(head.document.title, 'New life');
  const again = await publish('phoenix', rev(reborn));
  assert.equal((await get('phoenix')).document.title, 'New life');
  assert.ok(again.sequence > p.sequence);
  // History keeps the whole story, newest first, by actor id.
  const history = (await getDocumentHistory(ctx, { dataset: 'production', documentId: 'phoenix' })).entries;
  assert.deepEqual(history.map(entry => entry.action), ['publish', 'save', 'delete', 'publish', 'save']);
  assert.ok(history.every(entry => entry.actorId === 'alice' && /^\d{4}-\d{2}-\d{2}T/.test(entry.at)));
});

test('getDocumentHistory: read-drafts is required, limits are bounded, and entries carry no content', async () => {
  await save(page('hist', { title: 'SECRET-HISTORY-TITLE' }));
  await expectError(getDocumentHistory(makeCtx(db, { authorize: allow('read', 'write') }), { dataset: 'production', documentId: 'hist' }), 'denied');
  await expectError(getDocumentHistory(ctx, { dataset: 'production', documentId: 'hist', limit: 0 }), 'invalid_input');
  await expectError(getDocumentHistory(ctx, { dataset: 'production', documentId: 'hist', limit: 201 }), 'invalid_input');
  await expectError(getDocumentHistory(ctx, { dataset: 'production', documentId: 'bad id' }), 'invalid_input');
  const result = await getDocumentHistory(ctx, { dataset: 'production', documentId: 'drafts.hist', limit: 5 });
  assert.deepEqual(result.entries.map(entry => Object.keys(entry).sort()), [['action', 'actorId', 'at']]);
  assert.ok(!JSON.stringify(result).includes('SECRET-HISTORY-TITLE'));
  assert.deepEqual((await getDocumentHistory(ctx, { dataset: 'production', documentId: 'unknown-doc' })).entries, []);
});

test('getDocument reports when and by whom the current revision was written', async () => {
  const other = makeCtx(db, { actorId: 'studio-session:abc' });
  await save(page('stamped'), {}, other);
  const read = await get('stamped', 'previewDrafts');
  assert.equal(read.actorId, 'studio-session:abc');
  assert.match(read.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});
