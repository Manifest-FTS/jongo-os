import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { createDataset, publishDocument, queryDataset, saveDraft, sha256Hex, canonicalJson } from '../../dist/server/index.js';
import { expectError, freshDb, key, makeCtx, page, person, registry } from './helpers.mjs';

let db, ctx;
const SECRETS = ['SECRET-NOTE', 'SECRET-CODE', 'SECRET-HIDDEN', 'SECRET-EMAIL', 'UNDECLARED-FIELD', 'LEGACY-SECRET'];
const ref = id => ({ _type: 'reference', _ref: id });
const save = (input, extra = {}) => saveDraft(ctx, { dataset: 'production', registry, input, mutationKey: key(), ...extra });
const publish = async (id) => {
  const rows = (await db.sql(`SELECT native_rev FROM craft.revisions r JOIN craft.documents d ON d.current_revision_id = r.id WHERE d.native_id = $1`, [`drafts.${id}`])).rows;
  return publishDocument(ctx, { dataset: 'production', registry, documentId: id, mutationKey: key(), expectedNativeRev: rows[0].native_rev });
};
const q = (query, options = {}) => queryDataset(ctx, { dataset: 'production', registry, query, ...options });

before(async () => {
  db = await freshDb('query'); ctx = makeCtx(db);
  const dataset = await createDataset(ctx, { name: 'production' });
  await save(person('ada', { email: 'SECRET-EMAIL@example.invalid' })); await publish('ada');
  await save(page('pub-only', {
    internalNote: 'SECRET-NOTE', author: ref('ada'), extraField: 'UNDECLARED-FIELD',
    meta: { label: 'visible-label', internalCode: 'SECRET-CODE' }, blocks: [{ _key: 'b1', text: 'visible-text', hidden: 'SECRET-HIDDEN' }]
  })); await publish('pub-only');
  await save(page('both', { title: 'both published' })); const bothPub = await publish('both');
  await save(page('both', { title: 'both DRAFT' }), { expectedNativeRev: bothPub.nativeRev });
  await save(page('draft-only', { title: 'only a draft' }));
  await save(page('linker', { related: [{ ...ref('both'), _key: 'r1' }, { ...ref('draft-only'), _key: 'r2' }] })); await publish('linker');
  // A stored document of an unregistered type (e.g. left over from an older schema): privacy cannot be decided.
  const documentId = randomUUID(), revisionId = randomUUID();
  const payload = { note: 'LEGACY-SECRET' };
  await db.sql(`INSERT INTO craft.documents (id, dataset_id, native_id, type, logical_id, variant) VALUES ($1, $2, 'legacy-1', 'legacy', 'legacy-1', 'published')`, [documentId, dataset.id]);
  await db.sql(`INSERT INTO craft.revisions (id, dataset_id, document_id, sequence, schema_version, payload, payload_sha256, actor_id) VALUES ($1, $2, $3, 1, 1, $4::jsonb, $5, 'sql')`, [revisionId, dataset.id, documentId, JSON.stringify(payload), sha256Hex(canonicalJson(payload))]);
  await db.sql(`UPDATE craft.documents SET current_revision_id = $1 WHERE id = $2`, [revisionId, documentId]);
});
after(() => db.close());

const leaks = value => SECRETS.filter(secret => JSON.stringify(value).includes(secret));

test('public consumers never see private, undeclared or unregistered data, whatever the query shape', async () => {
  const queries = [
    '*', '*[]', '*[_type == "page"]', '*[_type == "page"]{...}', '*[_type == "page"]{ "all": @ }', '*[_type == "page"]{ ..., "ref": author-> }',
    '*[_type == "page"]{ "author": author->{...} }', '*[_type == "page"][0]{ "email": author->email }', '*[_type == "person"]{...}',
    '*[_id == "pub-only"][0]{ meta, blocks }', '*[_id == "pub-only"][0].meta', '*[_id == "pub-only"][0].blocks[]',
    '*[_type == "page"]{ "linked": related[]->{...} }', '*[references("ada")]{...}', 'array::join(*[_type == "person"].email, ",")', 'string::startsWith("x", "y")',
    '*[internalNote match "SECRET*"]', '*[defined(extraField)]', '*[_type == "legacy"]', '*[_id == "legacy-1"]', '*[email == "SECRET-EMAIL@example.invalid"]',
    '*[_type == "page"]{ "keys": ^._id }', 'count(*[internalNote == "SECRET-NOTE"])'
  ];
  for (const perspective of ['published', 'previewDrafts']) {
    for (const query of queries) {
      const result = await q(query, { perspective, consumer: perspective === 'published' ? undefined : 'public' }).catch(error => ({ result: `error:${error.code}` }));
      assert.deepEqual(leaks(result.result), [], `${perspective}: ${query}`);
    }
  }
  const raw = await queryDataset(ctx, { dataset: 'production', registry, query: '*', perspective: 'raw' });
  assert.deepEqual(leaks(raw.result), [], 'raw perspective is still privacy-filtered for the public consumer');
  // No oracle either: private fields cannot be filtered on.
  assert.deepEqual((await q('*[internalNote == "SECRET-NOTE"]')).result, []);
  assert.equal((await q('count(*[defined(extraField)])')).result, 0);
  assert.deepEqual((await q('*[_type == "person"]{_id, name}')).result, [{ _id: 'ada', name: 'Name ada' }]);
  const visible = (await q('*[_id == "pub-only"][0]{meta, blocks, "author": author->name}')).result;
  assert.deepEqual(visible, { meta: { label: 'visible-label' }, blocks: [{ _key: 'b1', text: 'visible-text' }], author: 'Name ada' });
});

test('the default consumer is the most restrictive (public)', async () => {
  assert.deepEqual(leaks((await q('*')).result), []);
  assert.deepEqual(leaks((await q('*', { consumer: undefined })).result), []);
  await expectError(q('*', { consumer: 'everyone' }), 'invalid_options');
});

test('the editor consumer sees private fields; unregistered types appear only for editors', async () => {
  const result = JSON.stringify((await q('*', { perspective: 'raw', consumer: 'editor' })).result);
  for (const secret of SECRETS) assert.ok(result.includes(secret), `${secret} visible to editors`);
});

test('perspectives matrix: published, previewDrafts and raw over published/draft/both/draft-only documents', async () => {
  const ids = async perspective => (await q('*[_type == "page"]{_id, title} | order(_id)', { perspective, consumer: 'editor' })).result;
  assert.deepEqual(await ids('published'), [
    { _id: 'both', title: 'both published' }, { _id: 'linker', title: 'Title linker' }, { _id: 'pub-only', title: 'Title pub-only' }]);
  assert.deepEqual(await ids('previewDrafts'), [
    { _id: 'both', title: 'both DRAFT' }, { _id: 'draft-only', title: 'only a draft' }, { _id: 'linker', title: 'Title linker' }, { _id: 'pub-only', title: 'Title pub-only' }]);
  assert.deepEqual(await ids('raw'), [
    { _id: 'both', title: 'both published' }, { _id: 'drafts.both', title: 'both DRAFT' }, { _id: 'drafts.draft-only', title: 'only a draft' },
    { _id: 'linker', title: 'Title linker' }, { _id: 'pub-only', title: 'Title pub-only' }]);
  // Archived (published) draft rows are not live: 'ada' was published, so only one variant exists everywhere.
  for (const perspective of ['published', 'previewDrafts', 'raw']) assert.deepEqual((await q('*[_type == "person"]._id', { perspective })).result, ['ada']);
});

test('dereference stays inside the perspective: drafts resolve only under previewDrafts/raw', async () => {
  const titles = perspective => q('*[_id == "linker"][0].related[]->title', { perspective, consumer: 'editor' }).then(r => r.result);
  assert.deepEqual(await titles('published'), ['both published', null]);
  assert.deepEqual(await titles('previewDrafts'), ['both DRAFT', 'only a draft']);
  assert.deepEqual((await q('*[_id == "linker"][0].related[]->_id', { perspective: 'raw', consumer: 'editor' })).result, ['both', null], 'raw refs are exact ids: a logical id resolves the published document only');
});

test('params work; invalid queries and params are typed errors that never echo document content', async () => {
  assert.deepEqual((await q('*[_type == $t]{_id}', { params: { t: 'person' } })).result, [{ _id: 'ada' }]);
  const bad = await expectError(q('*[_type == ]'), 'invalid_query');
  assert.ok(!SECRETS.some(secret => bad.message.includes(secret)));
  await expectError(q('nonexistent::fn()'), 'invalid_query');
  await expectError(q(''), 'invalid_query');
  await expectError(q(5), 'invalid_query');
  await expectError(q('*', { params: { 'bad-name': 1 } }), 'invalid_params');
  await expectError(q('*', { params: JSON.parse('{"__proto__": {"x": 1}}') }), 'invalid_params');
  await expectError(q('*', { params: { f: () => 1 } }), 'invalid_params');
  await expectError(q('*', { params: { n: Infinity } }), 'invalid_params');
  await expectError(q('*', { params: [] }), 'invalid_params');
  await expectError(q('*', { perspective: 'everything' }), 'invalid_perspective');
});

test('limits: query length, params size, result size, document count; never truncates', async () => {
  await expectError(q('*[_type == "page"]', { limits: { maxQueryLength: 5 } }), 'query_too_long');
  await expectError(q('*', { params: { blob: 'x'.repeat(200) }, limits: { maxParamsBytes: 50 } }), 'params_too_large');
  await expectError(q('*', { limits: { maxResultBytes: 100 } }), 'result_too_large');
  await expectError(q('*', { limits: { maxDocuments: 2 } }), 'dataset_too_large');
  for (const limits of [{ maxDocuments: 0 }, { maxDocuments: 10_000_000 }, { timeoutMs: 1.5 }, { maxResultBytes: -1 }, { maxQueryLength: 'x' }, 'nope']) {
    await expectError(q('*', { limits }), 'invalid_options');
  }
  const all = (await q('count(*)', { perspective: 'raw', consumer: 'editor' })).result;
  assert.equal((await q('count(*)', { perspective: 'raw', consumer: 'editor', limits: { maxDocuments: all } })).result, all, 'exactly at the limit is allowed');
  await expectError(q('count(*)', { perspective: 'raw', limits: { maxDocuments: all - 1 } }), 'dataset_too_large');
});

test('queries reflect committed state only and do not modify anything', async () => {
  const before = (await db.sql('SELECT (SELECT count(*) FROM craft.documents) AS d, (SELECT count(*) FROM craft.revisions) AS r, (SELECT count(*) FROM craft.audit_log) AS a')).rows[0];
  await q('*', { perspective: 'raw', consumer: 'editor' });
  const after = (await db.sql('SELECT (SELECT count(*) FROM craft.documents) AS d, (SELECT count(*) FROM craft.revisions) AS r, (SELECT count(*) FROM craft.audit_log) AS a')).rows[0];
  assert.deepEqual(after, before);
});
