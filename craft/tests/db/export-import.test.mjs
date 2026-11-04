import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import {
  createDataset, exportNdjson, getDocument, importNdjson, publishDocument, queryDataset, saveDraft, verifyNdjson
} from '../../dist/server/index.js';
import { count, expectError, freshDb, key, makeCtx, page, person, registry, spyExecutor } from './helpers.mjs';

let db, ctx;
const ref = id => ({ _type: 'reference', _ref: id });
const ASSETS = [{ _id: 'image-1', _type: 'sanity.imageAsset' }];
const enc = lines => new TextEncoder().encode(lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
const SECRETS = ['SECRET-NOTE', 'SECRET-CODE', 'SECRET-HIDDEN', 'SECRET-EMAIL'];
const save = (dataset, input, extra = {}) => saveDraft(ctx, { dataset, registry, input, mutationKey: key(), assets: ASSETS, ...extra });
async function pub(dataset, id) {
  const d = await getDocument(ctx, { dataset, registry, documentId: id, perspective: 'previewDrafts', consumer: 'editor' });
  return publishDocument(ctx, { dataset, registry, documentId: id, mutationKey: key(), expectedNativeRev: d.nativeRev, assets: ASSETS });
}
async function seed(dataset) {
  await createDataset(ctx, { name: dataset });
  await save(dataset, person('ada', { email: 'SECRET-EMAIL@example.invalid' })); await pub(dataset, 'ada');
  await save(dataset, person('grace'));
  await save(dataset, page('home', {
    title: 'Home \u2028 page', internalNote: 'SECRET-NOTE', author: ref('ada'), slug: { _type: 'slug', current: 'home' }, meta: { label: 'L', internalCode: 'SECRET-CODE' },
    hero: { _type: 'image', asset: ref('image-1'), alt: 'hero' }, blocks: [{ _key: 'b1', text: 't', hidden: 'SECRET-HIDDEN' }]
  })); await pub(dataset, 'home');
  await save(dataset, page('about')); const about = await pub(dataset, 'about');
  await save(dataset, page('about', { title: 'About (draft edit)' }), { expectedNativeRev: about.nativeRev });
  await save(dataset, page('wip', { related: [{ ...ref('home'), _key: 'k1' }] }));
}
const exportRaw = (dataset, extra = {}) => exportNdjson(ctx, { dataset, registry, perspective: 'raw', includePrivate: true, exportedAt: '2026-01-01T00:00:00.000Z', ...extra });
const imp = (dataset, bytes, extra = {}) => importNdjson(ctx, { dataset, registry, bytes, mode: 'apply', mutationKey: key(), assets: ASSETS, ...extra });
const dry = (dataset, bytes, extra = {}) => importNdjson(ctx, { dataset, registry, bytes, mode: 'dry-run', assets: ASSETS, ...extra });
const q = (dataset, query, perspective, consumer = 'editor') => queryDataset(ctx, { dataset, registry, query, perspective, consumer }).then(r => r.result);
const snapshot = async () => [await count(db, 'documents'), await count(db, 'revisions'), await count(db, 'mutations'), await count(db, 'audit_log'), await count(db, '"references"')];

before(async () => { db = await freshDb('exim'); ctx = makeCtx(db); await seed('production'); });
after(() => db.close());

test('export is deterministic: same bytes for the same state, sorted, LF-terminated, line-break safe, with a verifiable manifest', async () => {
  const a = await exportRaw('production');
  const b = await exportRaw('production', { exportedAt: '2027-02-02T00:00:00.000Z' });
  assert.ok(a.bytes.equals(b.bytes), 'bytes do not depend on exportedAt');
  assert.equal(a.manifest.sha256, b.manifest.sha256);
  assert.deepEqual({ ...a.manifest, exportedAt: 0 }, { ...b.manifest, exportedAt: 0 });
  const text = a.bytes.toString('utf8');
  assert.ok(text.endsWith('\n') && !text.includes('\r') && !text.startsWith('\ufeff'));
  assert.ok(!/[\u2028\u2029\u0085]/.test(text) && text.includes('\\u2028'), 'U+2028 is escaped');
  const docs = text.trimEnd().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(docs.map(d => d._id), ['about', 'drafts.about', 'ada', 'drafts.grace', 'home', 'drafts.wip']);
  for (const doc of docs) assert.deepEqual(Object.keys(doc), Object.keys(doc).slice().sort(), 'keys sorted');
  assert.equal(docs.find(d => d._id === 'home').title, 'Home \u2028 page');
  assert.equal(a.manifest.format, 'craft-ndjson-v1');
  assert.equal(a.manifest.documentCount, 6); assert.equal(a.manifest.byteLength, a.bytes.length);
  assert.deepEqual(a.manifest.counts.byVariant, { published: 3, draft: 3 });
  assert.equal(verifyNdjson(a.bytes, a.manifest), true);
  const tampered = Buffer.from(a.bytes); tampered[10] ^= 1;
  assert.equal(verifyNdjson(tampered, a.manifest), false);
  assert.equal(verifyNdjson(a.bytes.subarray(0, -1), a.manifest), false);
});

test('default export is public and published-only; includePrivate and raw widen it; secret-named keys never leave', async () => {
  const pubOnly = await exportNdjson(ctx, { dataset: 'production', registry, exportedAt: '2026-01-01T00:00:00.000Z' });
  const text = pubOnly.bytes.toString('utf8');
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `${secret} not in the public export`);
  assert.ok(!text.includes('drafts.'));
  assert.equal(pubOnly.manifest.documentCount, 3);
  const full = (await exportRaw('production')).bytes.toString('utf8');
  for (const secret of SECRETS) assert.ok(full.includes(secret), `${secret} is in the private export`);
  // A secret-looking property name is dropped even from a private export.
  await createDataset(ctx, { name: 'secrets' });
  await save('secrets', page('s1', { apiKey: 'sk-live-ABCDEF', nested: { password: 'hunter2' } }));
  const out = await exportRaw('secrets');
  assert.ok(!/sk-live|hunter2|apiKey|password/.test(out.bytes.toString('utf8')));
  assert.equal(out.manifest.redactedSecretKeyCount, 2);
});

test('export writes one audit row without content, and enforces limits', async () => {
  const before = await count(db, 'audit_log', `action = 'export.ndjson'`);
  const out = await exportRaw('production');
  assert.equal(await count(db, 'audit_log', `action = 'export.ndjson'`), before + 1);
  const detail = (await db.sql(`SELECT detail FROM craft.audit_log WHERE action = 'export.ndjson' ORDER BY id DESC LIMIT 1`)).rows[0].detail;
  assert.deepEqual(detail, { perspective: 'raw', includePrivate: true, documentCount: 6, byteLength: out.bytes.length, sha256: out.manifest.sha256 });
  await expectError(exportRaw('production', { limits: { maxDocuments: 2 } }), 'dataset_too_large');
  await expectError(exportRaw('production', { limits: { maxLineBytes: 50 } }), 'line_too_large');
  await expectError(exportRaw('production', { limits: { maxTotalBytes: 100 } }), 'output_too_large');
  await expectError(exportRaw('production', { limits: { maxDocuments: 0 } }), 'invalid_options');
  await expectError(exportRaw('production', { exportedAt: 'yesterday' }), 'invalid_options');
  await expectError(exportNdjson(ctx, { dataset: 'production', registry, perspective: 'nope' }), 'invalid_perspective');
  await createDataset(ctx, { name: 'empty' });
  const empty = await exportNdjson(ctx, { dataset: 'empty', registry });
  assert.equal(empty.bytes.length, 0); assert.equal(empty.manifest.documentCount, 0);
});

test('round trip: export -> import into a fresh dataset gives identical GROQ results in every perspective', async () => {
  const exported = await exportRaw('production');
  await createDataset(ctx, { name: 'copy' });
  const planned = await dry('copy', exported.bytes);
  assert.equal(planned.blocked, false); assert.equal(planned.applied, false);
  assert.deepEqual(planned.summary, { total: 6, create: 6, skip: 0, conflict: 0, invalid: 0 });
  const done = await imp('copy', exported.bytes);
  assert.equal(done.applied, true); assert.equal(done.blocked, false); assert.equal(done.replayed, false);
  assert.deepEqual(done.report.map(r => [r.id, r.outcome]), [['about', 'create'], ['drafts.about', 'create'], ['ada', 'create'], ['drafts.grace', 'create'], ['home', 'create'], ['drafts.wip', 'create']]);
  const norm = docs => docs.map(({ _rev, ...rest }) => rest);
  for (const perspective of ['published', 'previewDrafts', 'raw']) {
    for (const consumer of ['editor', 'public']) {
      const source = await q('production', '*|order(_id)', perspective, consumer);
      const copy = await q('copy', '*|order(_id)', perspective, consumer);
      assert.ok(source.length > 0);
      assert.deepEqual(norm(copy), norm(source), `${perspective}/${consumer}`);
    }
    const projection = '*[_type == "page"]|order(_id){_id, title, "author": author->name, "rel": related[]->title}';
    assert.deepEqual(await q('copy', projection, perspective), await q('production', projection, perspective));
  }
  // The copy is a real dataset: same lifecycle state, and its export differs from the source only in _rev.
  const again = await exportRaw('copy');
  const strip = bytes => bytes.toString('utf8').replace(/"_rev":"[0-9a-f]+",/g, '');
  assert.equal(strip(again.bytes), strip(exported.bytes));
  assert.notEqual(again.manifest.sha256, exported.manifest.sha256, 'fresh revisions get fresh _rev values');
  // Imported drafts are drafts; published are published.
  assert.deepEqual((await db.sql(`SELECT native_id, variant FROM craft.documents WHERE dataset_id = (SELECT id FROM craft.datasets WHERE name = 'copy') ORDER BY native_id`)).rows.map(r => `${r.native_id}:${r.variant}`),
    ['about:published', 'ada:published', 'drafts.about:draft', 'drafts.grace:draft', 'drafts.wip:draft', 'home:published']);
  assert.equal(await count(db, 'revisions', `document_id IN (SELECT id FROM craft.documents WHERE native_id = 'home')`), 2, 'both datasets have their own revision rows');
});

test('dry-run never writes; a clean apply writes one revision per document plus references, a receipt and an audit row', async () => {
  await createDataset(ctx, { name: 'plain' });
  const bytes = enc([{ _id: 'x1', _type: 'page', title: 'one', summary: 's', author: ref('p1') }, { _id: 'p1', _type: 'person', name: 'P' }, { _id: 'drafts.x2', _type: 'page', title: 'draft without summary' }]);
  const before = await snapshot();
  const planned = await dry('plain', bytes);
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(planned.summary, { total: 3, create: 3, skip: 0, conflict: 0, invalid: 0 });
  const result = await imp('plain', bytes);
  assert.equal(result.summary.create, 3);
  const after = await snapshot();
  assert.deepEqual(after.map((n, i) => n - before[i]), [3, 3, 1, 1, 1]);
  assert.equal((await db.sql(`SELECT detail->>'create' AS c, action FROM craft.audit_log ORDER BY id DESC LIMIT 1`)).rows[0].c, '3');
  const doc = await getDocument(ctx, { dataset: 'plain', registry, documentId: 'x1', consumer: 'editor' });
  assert.equal(doc.sequence, 1); assert.equal(doc.lockVersion, 1);
});

test('apply is all-or-nothing: unknown types and invalid documents are reported in dry-run and block apply, writing nothing', async () => {
  await createDataset(ctx, { name: 'strict' });
  const bytes = enc([
    { _id: 'good', _type: 'page', title: 'ok', summary: 's' },
    { _id: 'unk', _type: 'mystery', title: 'unknown type' },
    { _id: 'bad-pub', _type: 'page', title: 'x'.repeat(100), summary: 's' },
    { _id: 'no-summary', _type: 'page', title: 'published needs a summary' },
    { _id: 'bad id', _type: 'page', title: 'x' },
    { _id: 'ts', _type: 'page', title: 'x', summary: 's', _createdAt: 'yesterday' },
    { _id: 'dangling', _type: 'page', title: 'x', summary: 's', author: ref('nobody') }
  ]);
  const planned = await dry('strict', bytes);
  assert.equal(planned.blocked, true);
  assert.deepEqual(planned.report.map(r => [r.id, r.outcome, r.reason]), [
    ['good', 'create', undefined], ['unk', 'invalid', 'unknown_type'], ['bad-pub', 'invalid', 'validation_failed'], ['no-summary', 'invalid', 'validation_failed'],
    ['bad id', 'invalid', 'invalid_id'], ['ts', 'invalid', 'invalid_timestamp'], ['dangling', 'invalid', 'validation_failed']]);
  assert.deepEqual(planned.report[3].issues.map(i => i.code), ['publish_required']);
  assert.ok(!JSON.stringify(planned.report).includes('x'.repeat(100)), 'issues carry codes and schema messages, not content');
  const before = await snapshot();
  const result = await imp('strict', bytes);
  assert.equal(result.applied, false); assert.equal(result.blocked, true);
  assert.equal(result.report.length, 7);
  const after = await snapshot();
  assert.deepEqual(after.map((n, i) => n - before[i]), [0, 0, 0, 1, 0], 'nothing written, no receipt, one audit row');
  assert.equal((await db.sql(`SELECT action FROM craft.audit_log ORDER BY id DESC LIMIT 1`)).rows[0].action, 'import.blocked');
  // No receipt was recorded, so the same key can be retried with a corrected file.
  const k = key('retry');
  const first = await importNdjson(ctx, { dataset: 'strict', registry, bytes, mode: 'apply', mutationKey: k });
  assert.equal(first.blocked, true);
  const fixed = await importNdjson(ctx, { dataset: 'strict', registry, bytes: enc([{ _id: 'good', _type: 'page', title: 'ok', summary: 's' }]), mode: 'apply', mutationKey: k });
  assert.equal(fixed.applied, true);
});

test('intentional skips (assets, system and version documents) are reported and do not block; asset documents satisfy references only', async () => {
  await createDataset(ctx, { name: 'assets' });
  const bytes = enc([
    { _id: 'image-9', _type: 'sanity.imageAsset', url: 'https://example.invalid/x.png' },
    { _id: 'file-9', _type: 'sanity.fileAsset' }, { _id: 'versions.r1.x', _type: 'page', title: 'x' }, { _id: 'sys', _type: 'system.group' },
    { _id: 'withhero', _type: 'page', title: 'has image', summary: 's', hero: { _type: 'image', asset: ref('image-9') } }
  ]);
  const result = await importNdjson(ctx, { dataset: 'assets', registry, bytes, mode: 'apply', mutationKey: key() });
  assert.equal(result.applied, true); assert.equal(result.blocked, false);
  assert.deepEqual(result.report.map(r => [r.id, r.outcome, r.reason]), [
    ['image-9', 'skip', 'asset_not_supported'], ['file-9', 'skip', 'asset_not_supported'], ['versions.r1.x', 'skip', 'versions_not_supported'],
    ['sys', 'skip', 'system_type_not_supported'], ['withhero', 'create', undefined]]);
  assert.equal(await count(db, 'documents', `dataset_id = (SELECT id FROM craft.datasets WHERE name = 'assets')`), 1, 'asset documents are not stored');
  // Without an asset in the file or supplied by the host, the image reference is invalid.
  await createDataset(ctx, { name: 'assets2' });
  const bare = await importNdjson(ctx, { dataset: 'assets2', registry, bytes: enc([bytes_last()]), mode: 'dry-run' });
  assert.equal(bare.report[0].outcome, 'invalid');
});
const bytes_last = () => ({ _id: 'withhero', _type: 'page', title: 'has image', summary: 's', hero: { _type: 'image', asset: ref('image-9') } });

test('existing ids conflict instead of being overwritten; onConflict "skip" skips them and creates the rest', async () => {
  await createDataset(ctx, { name: 'conflicts' });
  const original = enc([{ _id: 'c1', _type: 'page', title: 'original', summary: 's' }]);
  await imp('conflicts', original);
  const next = enc([{ _id: 'c1', _type: 'page', title: 'REPLACEMENT', summary: 's' }, { _id: 'c2', _type: 'page', title: 'new', summary: 's' }]);
  const blocked = await imp('conflicts', next);
  assert.equal(blocked.blocked, true);
  assert.deepEqual(blocked.report.map(r => [r.id, r.outcome, r.reason]), [['c1', 'conflict', 'exists'], ['c2', 'create', undefined]]);
  assert.equal(await count(db, 'documents', `native_id = 'c2'`), 0, 'all-or-nothing: the new document was not written either');
  const skipped = await imp('conflicts', next, { onConflict: 'skip' });
  assert.equal(skipped.applied, true);
  assert.deepEqual(skipped.report.map(r => [r.id, r.outcome, r.reason]), [['c1', 'skip', 'exists'], ['c2', 'create', undefined]]);
  assert.equal((await getDocument(ctx, { dataset: 'conflicts', registry, documentId: 'c1', consumer: 'editor' })).document.title, 'original');
  // An archived document still owns its id.
  const second = await imp('conflicts', enc([{ _id: 'drafts.c1', _type: 'page', title: 'draft ok', summary: 's' }]));
  assert.equal(second.applied, true);
  const typeClash = await imp('conflicts', enc([{ _id: 'drafts.c2', _type: 'person', name: 'N' }]));
  assert.deepEqual(typeClash.report.map(r => [r.outcome, r.reason]), [['invalid', 'type_mismatch']]);
  const inFileClash = await dry('conflicts', enc([{ _id: 'n1', _type: 'page', title: 'x', summary: 's' }, { _id: 'drafts.n1', _type: 'person', name: 'N' }]));
  assert.deepEqual(inFileClash.report.map(r => r.reason), ['type_mismatch', 'type_mismatch']);
});

test('import preserves well-formed timestamps, drafts stay drafts, and replay by mutation key is idempotent', async () => {
  await createDataset(ctx, { name: 'times' });
  const bytes = enc([{ _id: 't1', _type: 'page', title: 'x', summary: 's', _createdAt: '2020-01-02T03:04:05.678Z', _updatedAt: '2021-02-03T04:05:06.789Z', _rev: 'foreign-rev' }]);
  const k = key('replay');
  const first = await imp('times', bytes, { mutationKey: k });
  const doc = await getDocument(ctx, { dataset: 'times', registry, documentId: 't1', consumer: 'editor' });
  assert.equal(doc.document._createdAt, '2020-01-02T03:04:05.678Z'); assert.equal(doc.document._updatedAt, '2021-02-03T04:05:06.789Z');
  assert.notEqual(doc.document._rev, 'foreign-rev');
  const replay = await imp('times', bytes, { mutationKey: k });
  assert.equal(replay.replayed, true); assert.equal(replay.applied, true); assert.deepEqual(replay.summary, first.summary); assert.deepEqual(replay.report, []);
  assert.equal(await count(db, 'documents', `native_id = 't1'`), 1);
  await expectError(imp('times', enc([{ _id: 't2', _type: 'page', title: 'x', summary: 's' }]), { mutationKey: k }), 'idempotency_conflict');
});

test('strict parsing rejects malformed input with typed errors that carry a line number, never content', async () => {
  const cases = {
    duplicate_key: ['{"_id":"a","_type":"page","title":"SECRET-DUP","title":"x"}'],
    unsafe_key: ['{"_id":"a","_type":"page","__proto__":{"x":"SECRET-PROTO"}}'],
    unicode: ['{"_id":"a","_type":"page","title":"SECRET-\\ud800"}'],
    json: ['{"_id":"a","_type":"page","title":"SECRET-JSON"'],
    identity: ['{"_type":"page","title":"SECRET-NO-ID"}'],
    duplicate_id: ['{"_id":"a","_type":"page","title":"x"}', '{"_id":"a","_type":"page","title":"SECRET-AGAIN"}'],
    bom: ['{"_id":"a","_type":"page"}', '\ufeff{"_id":"b","_type":"page"}'],
    number: ['{"_id":"a","_type":"page","n":1e999}'],
    depth_limit: [`{"_id":"a","_type":"page","d":${'['.repeat(40)}${']'.repeat(40)}}`]
  };
  await createDataset(ctx, { name: 'parse' });
  const before = await snapshot();
  for (const [code, lines] of Object.entries(cases)) {
    for (const mode of ['dry-run', 'apply']) {
      const error = await expectError(importNdjson(ctx, { dataset: 'parse', registry, bytes: enc(lines), mode, mutationKey: key() }), code);
      assert.ok(error.line >= 1, `${code} reports a line`);
      assert.ok(!/SECRET/.test(error.message), `${code} message has no content`);
    }
  }
  await expectError(importNdjson(ctx, { dataset: 'parse', registry, bytes: Uint8Array.from([0x7b, 0xff, 0x7d, 10]), mode: 'dry-run' }), 'utf8');
  await expectError(importNdjson(ctx, { dataset: 'parse', registry, bytes: new TextEncoder().encode(`{"_id":"a","_type":"page","t":"\\u0000"}\n`), mode: 'dry-run' }), 'unicode');
  assert.deepEqual(await snapshot(), before);
  // Tolerated: leading BOM, CRLF, blank lines.
  const lenient = new TextEncoder().encode('\ufeff{"_id":"l1","_type":"person","name":"A"}\r\n\r\n   \n{"_id":"l2","_type":"person","name":"B"}');
  const ok = await dry('parse', lenient);
  assert.equal(ok.summary.create, 2);
});

test('import bounds: document count, byte size, per-line size; option validation', async () => {
  await createDataset(ctx, { name: 'bounds' });
  const three = enc([1, 2, 3].map(i => ({ _id: `b${i}`, _type: 'person', name: 'N' })));
  assert.equal((await dry('bounds', three, { limits: { maxDocuments: 3 } })).summary.create, 3);
  await expectError(dry('bounds', three, { limits: { maxDocuments: 2 } }), 'record_limit');
  await expectError(dry('bounds', three, { limits: { maxBytes: 50 } }), 'file_limit');
  await expectError(dry('bounds', three, { limits: { maxDocuments: 0 } }), 'invalid_options');
  await expectError(dry('bounds', three, { limits: { maxBytes: 10 ** 12 } }), 'invalid_options');
  await expectError(importNdjson(ctx, { dataset: 'bounds', registry, bytes: three, mode: 'merge' }), 'invalid_options');
  await expectError(importNdjson(ctx, { dataset: 'bounds', registry, bytes: three, mode: 'apply' }), 'invalid_input');
  await expectError(imp('bounds', three, { onConflict: 'overwrite' }), 'invalid_options');
  await expectError(imp('bounds', 'not bytes'), 'invalid_options');
  const huge = enc([{ _id: 'huge', _type: 'person', name: 'x', p1: 'y'.repeat(100_000), p2: 'y'.repeat(100_000), p3: 'y'.repeat(100_000), p4: 'y'.repeat(100_000), p5: 'y'.repeat(100_000), p6: 'y'.repeat(100_000) }]);
  const report = await dry('bounds', huge);
  assert.equal(report.report[0].reason, 'too_large');
});

test('a failure anywhere inside apply rolls everything back', async () => {
  await createDataset(ctx, { name: 'rollback' });
  const bytes = enc([{ _id: 'r1', _type: 'page', title: 'x', summary: 's', author: ref('r2') }, { _id: 'r2', _type: 'person', name: 'N' }]);
  const before = await snapshot();
  for (const failOn of [/INSERT INTO craft\.documents/, /INSERT INTO craft\.revisions/, /UPDATE craft\.documents d SET current_revision_id/, /INSERT INTO craft\."references"/, /INSERT INTO craft\.mutations/, /INSERT INTO craft\.audit_log/]) {
    const spy = spyExecutor(db.executor, { failOn });
    const error = await expectError(importNdjson(makeCtx(db, { executor: spy }), { dataset: 'rollback', registry, bytes, mode: 'apply', mutationKey: key() }), 'unavailable');
    assert.ok(!/SECRET_SQL|INSERT|craft\./.test(error.message));
    assert.deepEqual(await snapshot(), before, `nothing persisted when ${failOn} fails`);
  }
  assert.equal((await imp('rollback', bytes)).applied, true, 'and the same file applies cleanly afterwards');
});

test('concurrent applies of the same file with different keys: one set of documents, the other is a clean conflict', async () => {
  await createDataset(ctx, { name: 'race' });
  const bytes = enc([1, 2, 3, 4].map(i => ({ _id: `r${i}`, _type: 'person', name: `N${i}` })));
  const settled = await Promise.allSettled([imp('race', bytes), imp('race', bytes), imp('race', bytes)]);
  const ok = settled.filter(r => r.status === 'fulfilled').map(r => r.value);
  const applied = ok.filter(r => r.applied), blocked = ok.filter(r => r.blocked);
  assert.equal(applied.length, 1, 'exactly one apply wins');
  assert.equal(applied.length + blocked.length + settled.filter(r => r.status === 'rejected').length, 3);
  assert.equal(await count(db, 'documents', `dataset_id = (SELECT id FROM craft.datasets WHERE name = 'race')`), 4);
  assert.equal(await count(db, 'revisions', `dataset_id = (SELECT id FROM craft.datasets WHERE name = 'race')`), 4);
});
