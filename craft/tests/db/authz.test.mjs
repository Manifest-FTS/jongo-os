import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import {
  createDataset, deleteDocument, discardDraft, exportNdjson, getDataset, getDocument, getDocumentHistory, importNdjson, listDocuments, publishDocument, queryDataset, saveDraft, unpublishDocument
} from '../../dist/server/index.js';
import { ALL_ACTIONS, count, freshDb, key, makeCtx, page, registry, spyExecutor } from './helpers.mjs';

let db;
before(async () => {
  db = await freshDb('authz');
  const ctx = makeCtx(db);
  await createDataset(ctx, { name: 'production' });
  const saved = await saveDraft(ctx, { dataset: 'production', registry, input: page('p1'), mutationKey: key() });
  await publishDocument(ctx, { dataset: 'production', registry, documentId: 'p1', mutationKey: key(), expectedNativeRev: saved.nativeRev });
});
after(() => db.close());

const D = { dataset: 'production', registry };
const base = { ...D, documentId: 'p1', expectedLockVersion: 1 };
const ndjson = new TextEncoder().encode(`${JSON.stringify({ _id: 'zz', _type: 'page', title: 't', summary: 's' })}\n`);
// [label, actions the call must ask the host for (all of them), invoke]
const CALLS = [
  ['createDataset', ['admin'], ctx => createDataset(ctx, { name: 'another' })],
  ['getDataset', ['admin'], ctx => getDataset(ctx, 'production')],
  ['saveDraft', ['write'], ctx => saveDraft(ctx, { ...D, input: page('authz-new'), mutationKey: key() })],
  ['discardDraft', ['write'], ctx => discardDraft(ctx, { ...base, mutationKey: key() })],
  ['publishDocument', ['publish'], ctx => publishDocument(ctx, { ...base, mutationKey: key() })],
  ['unpublishDocument', ['publish'], ctx => unpublishDocument(ctx, { ...base, mutationKey: key() })],
  ['getDocumentHistory', ['read-drafts'], ctx => getDocumentHistory(ctx, { ...D, documentId: 'p1' })],
  ['deleteDocument', ['write', 'publish'], ctx => deleteDocument(ctx, { dataset: 'production', documentId: 'p1', expectedLockVersion: 1, mutationKey: key() })],
  ['getDocument published/public', ['read'], ctx => getDocument(ctx, { ...D, documentId: 'p1' })],
  ['getDocument previewDrafts', ['read-drafts'], ctx => getDocument(ctx, { ...D, documentId: 'p1', perspective: 'previewDrafts' })],
  ['getDocument raw', ['read-drafts'], ctx => getDocument(ctx, { ...D, documentId: 'p1', perspective: 'raw' })],
  ['getDocument published/editor', ['read-drafts', 'read'], ctx => getDocument(ctx, { ...D, documentId: 'p1', consumer: 'editor' })],
  ['listDocuments published', ['read'], ctx => listDocuments(ctx, { dataset: 'production' })],
  ['listDocuments previewDrafts', ['read-drafts'], ctx => listDocuments(ctx, { dataset: 'production', perspective: 'previewDrafts' })],
  ['queryDataset published', ['read'], ctx => queryDataset(ctx, { ...D, query: '*[_type == "page"]' })],
  ['queryDataset previewDrafts', ['read-drafts'], ctx => queryDataset(ctx, { ...D, query: '*', perspective: 'previewDrafts' })],
  ['queryDataset raw', ['read-drafts'], ctx => queryDataset(ctx, { ...D, query: '*', perspective: 'raw' })],
  ['queryDataset published/editor', ['read-drafts', 'read'], ctx => queryDataset(ctx, { ...D, query: '*', consumer: 'editor' })],
  ['exportNdjson', ['export'], ctx => exportNdjson(ctx, { ...D })],
  ['exportNdjson includePrivate', ['export', 'export-private'], ctx => exportNdjson(ctx, { ...D, includePrivate: true })],
  ['exportNdjson raw', ['export', 'read-drafts'], ctx => exportNdjson(ctx, { ...D, perspective: 'raw' })],
  ['importNdjson dry-run', ['import'], ctx => importNdjson(ctx, { ...D, bytes: ndjson, mode: 'dry-run' })],
  ['importNdjson apply', ['import'], ctx => importNdjson(ctx, { ...D, bytes: ndjson, mode: 'apply', mutationKey: key() })]
];

const DENIALS = {
  'returns false': () => false,
  'returns undefined': () => undefined,
  'returns null': () => null,
  'returns the string "true"': () => 'true',
  'returns 1': () => 1,
  'returns an object': () => ({ allowed: true }),
  'throws': () => { throw new Error('authorizer exploded SECRET'); },
  'rejects': async () => { throw new Error('authorizer rejected'); },
  'resolves false': async () => false,
  'resolves undefined': async () => undefined,
  'resolves "yes"': async () => 'yes'
};

for (const [label, actions, invoke] of CALLS) {
  test(`${label}: denied (fail-closed) before any database access`, async () => {
    for (const [mode, authorize] of Object.entries(DENIALS)) {
      const spy = spyExecutor(db.executor);
      const asked = [];
      const ctx = makeCtx(db, { executor: spy, authorize: (...args) => { asked.push(args); return authorize(...args); } });
      await assert.rejects(() => invoke(ctx), error => error?.name === 'CraftError' && error.code === 'denied' && !/SECRET|exploded/.test(error.message), mode);
      assert.equal(spy.log.length, 0, `no statement ran when authorize ${mode}`);
      assert.deepEqual(asked[0].slice(0, 3), ['alice', actions[0], label.startsWith('createDataset') ? 'another' : 'production']);
    }
  });
  test(`${label}: asks for exactly ${actions.join(' + ')} and works when only those are granted`, async () => {
    const asked = [];
    const authorize = async (_actor, action) => { asked.push(action); return actions.includes(action); };
    const result = await invoke(makeCtx(db, { authorize })).then(() => 'ok', error => error.code);
    assert.notEqual(result, 'denied');
    assert.deepEqual([...new Set(asked)].sort(), [...actions].sort());
    for (const missing of actions) {
      const only = ALL_ACTIONS.filter(a => a !== missing);
      await assert.rejects(() => invoke(makeCtx(db, { authorize: async (_actor, action) => only.includes(action) })), error => error.code === 'denied', `denied without ${missing}`);
    }
  });
}

test('authorize is required; a context without it is rejected, never defaulted to allow', async () => {
  for (const authorize of [undefined, null, 'allow', true]) {
    const spy = spyExecutor(db.executor);
    await assert.rejects(() => getDocument({ executor: spy, actorId: 'alice', authorize }, { ...D, documentId: 'p1' }), error => error.code === 'invalid_input');
    assert.equal(spy.log.length, 0);
  }
  await assert.rejects(() => getDocument(null, { ...D, documentId: 'p1' }), error => error.code === 'invalid_input');
  await assert.rejects(() => getDocument({ executor: {}, actorId: 'alice', authorize: () => true }, { ...D, documentId: 'p1' }), error => error.code === 'invalid_input');
});

test('denied writes leave no trace: no rows, receipts or audit entries', async () => {
  const before = [await count(db, 'documents'), await count(db, 'revisions'), await count(db, 'mutations'), await count(db, 'audit_log')];
  const denyWrite = makeCtx(db, { authorize: async (_a, action) => action !== 'write' });
  await assert.rejects(() => saveDraft(denyWrite, { ...D, input: page('nope'), mutationKey: key() }), error => error.code === 'denied');
  assert.deepEqual([await count(db, 'documents'), await count(db, 'revisions'), await count(db, 'mutations'), await count(db, 'audit_log')], before);
});

test('denied callers learn nothing from input validation: malformed requests are denied first', async () => {
  const ctx = makeCtx(db, { authorize: async () => false });
  const bad = [
    () => saveDraft(ctx, { ...D, input: { _type: 'not-registered' }, mutationKey: 'bad key with spaces' }),
    () => publishDocument(ctx, { ...D, documentId: 'bad id', mutationKey: 'x' }),
    () => unpublishDocument(ctx, { ...D, documentId: 'bad id', mutationKey: 'x', expectedLockVersion: -5 }),
    () => discardDraft(ctx, { ...D, documentId: 'bad id', mutationKey: 'x' }),
    () => deleteDocument(ctx, { dataset: 'production', documentId: 'bad id', mutationKey: 'x', expectedLockVersion: -5 }),
    () => getDocument(ctx, { ...D, documentId: 'bad id' }),
    () => listDocuments(ctx, { dataset: 'production', limit: 9999, cursor: '!' }),
    () => queryDataset(ctx, { ...D, query: '*[', params: { 'bad name': 1 } }),
    () => importNdjson(ctx, { ...D, bytes: new Uint8Array([0xff]), mode: 'apply' })
  ];
  for (const call of bad) await assert.rejects(call, error => error.code === 'denied');
});

test('the host sees the actor id and dataset it must decide on; one actor cannot borrow another\'s authority', async () => {
  const seen = [];
  const ctx = makeCtx(db, { actorId: 'bob', authorize: async (actor, action, dataset) => { seen.push([actor, action, dataset]); return actor === 'alice'; } });
  await assert.rejects(() => saveDraft(ctx, { ...D, input: page('bob-doc'), mutationKey: key() }), error => error.code === 'denied');
  assert.deepEqual(seen, [['bob', 'write', 'production']]);
});
