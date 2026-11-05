import assert from 'node:assert/strict';
import test from 'node:test';
import { createContentRegistry, defineType } from '../dist/index.js';
import {
  CraftError, applyPerspective, canonicalJson, createPgExecutor, findJsonViolation, loadMigrations, migrationChecksum, parseNdjson, redact,
  runGroq, serializeNdjson, sha256Hex, toPublicDocument, toQueryDocuments, verifyNdjson, getDocument
} from '../dist/server/index.js';

const registry = createContentRegistry([
  defineType({ name: 'page', type: 'document', schemaVersion: 1, fields: [
    { name: 'title', type: 'string' }, { name: 'secret', type: 'string', private: true },
    { name: 'meta', type: 'object', fields: [{ name: 'a', type: 'string' }, { name: 'hidden', type: 'string', private: true }] },
    { name: 'items', type: 'array', of: [{ type: 'object', fields: [{ name: 'x', type: 'string' }, { name: 'y', type: 'string', private: true }] }] },
    { name: 'author', type: 'reference', to: ['page'] }, { name: 'slug', type: 'slug' }, { name: 'img', type: 'image' }
  ] })
]);
const ts = '2026-01-01T00:00:00.000Z';
const doc = (id, extra = {}) => ({ _id: id, _type: 'page', _rev: 'r', _createdAt: ts, _updatedAt: ts, title: id, ...extra });

test('findJsonViolation: unsafe keys, NUL, lone surrogates, accessors, cycles, depth and size at any depth', () => {
  assert.equal(findJsonViolation({ a: [1, 'x', null, true, { b: 2.5 }] }), null);
  assert.equal(findJsonViolation(JSON.parse('{"a":{"b":[{"__proto__":1}]}}')), 'unsafe_key');
  assert.equal(findJsonViolation(JSON.parse('{"constructor":1}')), 'unsafe_key');
  assert.equal(findJsonViolation(JSON.parse('{"prototype":1}')), 'unsafe_key');
  assert.equal(findJsonViolation({ a: 'x\u0000y' }), 'unicode');
  assert.equal(findJsonViolation({ a: ['ok', 'lone\udc00'] }), 'unicode');
  assert.equal(findJsonViolation({ 'k\ud800': 1 }), 'unicode');
  assert.equal(findJsonViolation({ a: 'pair \ud83d\ude00 ok' }), null);
  assert.equal(findJsonViolation({ get a() { throw new Error('getter must not run'); } }), 'not_json');
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(findJsonViolation(cyclic), 'cycle');
  assert.equal(findJsonViolation({ a: undefined }), 'not_json');
  assert.equal(findJsonViolation({ a: () => 1 }), 'not_json');
  assert.equal(findJsonViolation({ a: 10n }), 'not_json');
  assert.equal(findJsonViolation({ a: NaN }), 'number');
  assert.equal(findJsonViolation({ a: 2 ** 60 }), 'number');
  assert.equal(findJsonViolation(new Map()), 'not_json');
  assert.equal(findJsonViolation({ a: Symbol('x') }), 'not_json');
  assert.equal(findJsonViolation({ [Symbol('k')]: 1 }), 'not_json');
  assert.equal(findJsonViolation([1, , 3]), 'not_json');
  assert.equal(findJsonViolation(Object.assign([1], { extra: 1 })), 'not_json');
  let deep = 1; for (let i = 0; i < 40; i++) deep = [deep];
  assert.equal(findJsonViolation(deep), 'depth_limit');
  assert.equal(findJsonViolation(Array.from({ length: 2001 }, () => 1)), 'collection_limit');
  assert.equal(findJsonViolation(Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`k${i}`, 1]))), 'collection_limit');
  assert.equal(findJsonViolation('x'.repeat(100_001)), 'string_limit');
  assert.equal(findJsonViolation(Array.from({ length: 20 }, () => Array.from({ length: 1100 }, () => 1))), 'node_limit');
  const proxy = new Proxy({}, { ownKeys() { throw new Error('trap'); } });
  assert.equal(findJsonViolation(proxy), 'not_json');
});

test('canonicalJson sorts keys at every depth, keeps array order and hashes equal input equally', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, 1], c: null } }), '{"a":{"c":null,"d":[3,1]},"b":1}');
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  assert.equal(sha256Hex(canonicalJson({ a: 1 })), sha256Hex('{"a":1}'));
  assert.equal(canonicalJson(-0), '0');
  assert.throws(() => canonicalJson(undefined));
});

test('redact: bounded, secret-free, prototype-safe audit detail', () => {
  const out = redact({ id: 'x', password: 'hunter2', nested: { apiKey: 'k', token: 't', ok: 1 }, list: Array.from({ length: 100 }, (_, i) => i), long: 'y'.repeat(1000), __proto__x: 1 });
  assert.equal(out.password, '[redacted]'); assert.equal(out.nested.apiKey, '[redacted]'); assert.equal(out.nested.token, '[redacted]'); assert.equal(out.nested.ok, 1);
  assert.equal(out.list.length, 50); assert.ok(out.long.length < 210);
  assert.ok(!JSON.stringify(out).includes('hunter2'));
  assert.deepEqual(redact(JSON.parse('{"__proto__":{"x":1},"a":1}')), { a: 1 });
  assert.deepEqual(redact('text'), { value: 'text' });
  assert.deepEqual(redact(null), { value: null });
  assert.deepEqual(redact(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, 'z'.repeat(190)]))), { truncated: true });
  const deep = { a: { b: { c: { d: { e: 1 } } } } };
  assert.equal(redact(deep).a.b.c.d, '[depth]');
});

test('toPublicDocument: allowlist at every depth, envelope kept, unregistered types dropped', () => {
  const full = doc('p', {
    secret: 'S', undeclared: 'U', meta: { a: 'A', hidden: 'H', _type: 'meta', stray: 1 }, items: [{ _key: 'k', x: 'X', y: 'Y', z: 'Z' }],
    author: { _type: 'reference', _ref: 'q', _weak: true, extra: 'E' }, slug: { _type: 'slug', current: 'p', extra: 1 },
    img: { _type: 'image', asset: { _type: 'reference', _ref: 'a', url: 'U' }, alt: 'alt', hotspot: { x: 1 } }
  });
  assert.deepEqual(toPublicDocument(full, registry), {
    _id: 'p', _type: 'page', _rev: 'r', _createdAt: ts, _updatedAt: ts, title: 'p',
    meta: { a: 'A', _type: 'meta' }, items: [{ _key: 'k', x: 'X' }], author: { _type: 'reference', _ref: 'q', _weak: true }, slug: { _type: 'slug', current: 'p' },
    img: { _type: 'image', asset: { _type: 'reference', _ref: 'a' }, alt: 'alt' }
  });
  assert.equal(toPublicDocument({ _id: 'x', _type: 'legacy' }, registry), null);
  assert.deepEqual(toPublicDocument(doc('w', { title: 5, meta: 'str', items: 'no' }), registry), { _id: 'w', _type: 'page', _rev: 'r', _createdAt: ts, _updatedAt: ts });
});

test('applyPerspective: published / previewDrafts / raw over published, draft, both and versions', () => {
  const docs = [{ _id: 'a', _type: 't', v: 'pub' }, { _id: 'drafts.a', _type: 't', v: 'draft' }, { _id: 'b', _type: 't' }, { _id: 'drafts.c', _type: 't' }, { _id: 'versions.r.d', _type: 't' }];
  assert.deepEqual(applyPerspective(docs, 'published').map(d => d._id), ['a', 'b']);
  assert.deepEqual(applyPerspective(docs, 'raw').map(d => d._id), docs.map(d => d._id));
  const preview = applyPerspective(docs, 'previewDrafts');
  assert.deepEqual(preview.map(d => d._id).sort(), ['a', 'b', 'c']);
  assert.equal(preview.find(d => d._id === 'a').v, 'draft');
});

test('runGroq (pure): privacy happens before evaluation, limits are typed, errors are sanitized', async () => {
  const docs = [doc('a', { secret: 'TOP', author: { _type: 'reference', _ref: 'b' } }), doc('b', { secret: 'TOP2' }), { _id: 'x', _type: 'legacy', note: 'TOP3' }];
  const run = (query, extra = {}) => runGroq({ documents: docs, query, registry, ...extra });
  assert.ok(!JSON.stringify((await run('*')).result).includes('TOP'));
  assert.deepEqual((await run('*[secret == "TOP"]')).result, []);
  assert.deepEqual((await run('*[_id == "a"][0].author->secret')).result, null);
  assert.equal((await run('*[_id == "a"][0].author->secret', { consumer: 'editor' })).result, 'TOP2');
  assert.equal((await run('count(*)')).result, 2);
  assert.equal((await run('count(*)', { consumer: 'editor' })).result, 3);
  assert.equal((await run('*[_id == $id][0].title', { params: { id: 'b' } })).result, 'b');
  const code = async (promise) => { try { await promise; } catch (error) { return error.code; } return 'none'; };
  assert.equal(await code(run('*[')), 'invalid_query');
  assert.equal(await code(run('x'.repeat(20), { limits: { maxQueryLength: 5 } })), 'query_too_long');
  assert.equal(await code(run('*', { limits: { maxResultBytes: 10 } })), 'result_too_large');
  assert.equal(await code(run('*', { limits: { maxDocuments: 1 } })), 'too_many_documents');
  assert.equal(await code(run('*', { perspective: 'x' })), 'invalid_perspective');
  assert.equal(await code(run('*', { consumer: 'x' })), 'invalid_options');
  assert.equal(await code(runGroq({ documents: docs, query: '*' })), 'invalid_options', 'registry is required');
  assert.equal(await code(run('*', { limits: { timeoutMs: 0 } })), 'invalid_options');
  assert.equal(await code(runGroq({ documents: [{ _id: 'a', _type: 't' }, { _id: 'a', _type: 't' }], query: '*', registry })), 'invalid_documents');
  assert.equal(await code(run('*', { params: { fn() {} } })), 'invalid_params');
});

test('serializeNdjson / parseNdjson: deterministic bytes, escaping, ordering, strict parsing', () => {
  const docs = [doc('b', { title: 'line\u2028break\u0085', z: 1, a: { y: 1, x: 2 } }), doc('a'), doc('drafts.a', { title: 'draft' })];
  const one = serializeNdjson(docs, { exportedAt: ts, perspective: 'raw', includePrivate: true, registry });
  const two = serializeNdjson([...docs].reverse(), { exportedAt: '2030-01-01T00:00:00Z', perspective: 'raw', includePrivate: true, registry });
  assert.ok(one.bytes.equals(two.bytes));
  const text = one.bytes.toString('utf8');
  assert.ok(!/[\u2028\u0085]/.test(text) && text.includes('\\u2028') && text.includes('\\u0085'));
  assert.deepEqual(text.trimEnd().split('\n').map(l => JSON.parse(l)._id), ['a', 'drafts.a', 'b']);
  assert.ok(text.includes('"a":{"x":2,"y":1}'));
  assert.equal(one.manifest.sha256, sha256Hex(one.bytes));
  const parsed = parseNdjson(one.bytes);
  assert.equal(parsed.documents.length, 3);
  assert.equal(Object.getPrototypeOf(parsed.documents[0]), null, 'prototype-less objects');
  assert.deepEqual(toQueryDocuments(parsed.documents).map(d => d._id), ['a', 'drafts.a', 'b']);
  assert.equal(parsed.stats.sha256, one.manifest.sha256);
  assert.equal(verifyNdjson(one.bytes, one.manifest), true);
  assert.equal(verifyNdjson(one.bytes, { ...one.manifest, documentCount: 4 }), false);
  // Public export: published only, private fields gone, unregistered types omitted and counted.
  const pub = serializeNdjson([doc('a', { secret: 'SHH' }), { ...doc('u'), _type: 'legacy' }, doc('drafts.a')], { exportedAt: ts, registry });
  assert.ok(!pub.bytes.toString().includes('SHH')); assert.equal(pub.manifest.documentCount, 1);
  assert.equal(pub.manifest.omitted.unregisteredType, 1);
  assert.equal(pub.manifest.schema.craftSchemaVersions.page, 1);
});

test('serializeNdjson rejects malformed documents and options with typed errors', () => {
  const code = fn => { try { fn(); } catch (error) { return error.code; } return 'none'; };
  const opts = { exportedAt: ts, registry };
  assert.equal(code(() => serializeNdjson([doc('a'), doc('a')], opts)), 'duplicate_id');
  assert.equal(code(() => serializeNdjson([{ _id: 'a', _type: 'page' }], opts)), 'invalid_document');
  assert.equal(code(() => serializeNdjson([doc('a', { t: 'bad\u0000' })], { ...opts, includePrivate: true })), 'invalid_document');
  assert.equal(code(() => serializeNdjson([doc('a', { t: 'x'.repeat(500) })], { ...opts, includePrivate: true, limits: { maxLineBytes: 100 } })), 'line_too_large');
  assert.equal(code(() => serializeNdjson([doc('a'), doc('b')], { ...opts, limits: { maxDocuments: 1 } })), 'too_many_documents');
  assert.equal(code(() => serializeNdjson([doc('a')], { ...opts, limits: { maxTotalBytes: 10 }, includePrivate: true })), 'output_too_large');
  assert.equal(code(() => serializeNdjson([doc('a')], { ...opts, exportedAt: 'now' })), 'invalid_options');
  assert.equal(code(() => serializeNdjson([doc('a')], { ...opts, includePrivate: 'yes' })), 'invalid_options');
  assert.equal(code(() => serializeNdjson([doc('a')], { ...opts, perspective: 'all' })), 'invalid_perspective');
  assert.equal(code(() => serializeNdjson([doc('a')], { exportedAt: ts })), 'invalid_options');
});

test('parseNdjson: every safeguard has its own typed code and a line number', () => {
  const enc = s => new TextEncoder().encode(s);
  const failure = text => { try { parseNdjson(typeof text === 'string' ? enc(text) : text); } catch (error) { return [error.code, error.line]; } return ['none', 0]; };
  assert.deepEqual(failure('{"_id":"a","_type":"t","x":1,"x":2}\n'), ['duplicate_key', 1]);
  assert.deepEqual(failure('{"_id":"a","_type":"t"}\n{"_id":"b","_type":"t","__proto__":1}\n'), ['unsafe_key', 2]);
  assert.deepEqual(failure('{"_id":"a","_type":"t","constructor":1}\n'), ['unsafe_key', 1]);
  assert.deepEqual(failure('{"_id":"a","_type":"t","s":"\\u0000"}\n'), ['unicode', 1]);
  assert.deepEqual(failure('{"_id":"a","_type":"t","s":"\\ud800"}\n'), ['unicode', 1]);
  assert.deepEqual(failure('{"_id":"a","_type":"t","s":"\\ude00x"}\n'), ['unicode', 1]);
  assert.deepEqual(failure(Uint8Array.from([0x7b, 0xc3, 0x28, 0x7d, 10])), ['utf8', 1]);
  assert.deepEqual(failure('{"_id":"a"}\n'), ['identity', 1]);
  assert.deepEqual(failure('[1]\n'), ['identity', 1]);
  assert.deepEqual(failure('"s"\n'), ['identity', 1]);
  assert.deepEqual(failure('{"_id":"","_type":"t"}\n'), ['identity', 1]);
  assert.deepEqual(failure('{"_id":"drafts.","_type":"t"}\n'), ['identity', 1]);
  assert.deepEqual(failure('{"_id":"a","_type":"t"}\n{"_id":"a","_type":"t"}\n'), ['duplicate_id', 2]);
  assert.deepEqual(failure('{"_id":"a","_type":"t"} trailing\n'), ['json', 1]);
  assert.deepEqual(failure('{"_id":"a","_type":"t","n":01}\n'), ['json', 1]);
  assert.deepEqual(failure('{"_id":"a","_type":"t","n":9007199254740993}\n'), ['number', 1]);
  assert.deepEqual(failure('{"_id":"a","_type":"t","n":1e999}\n'), ['number', 1]);
  assert.deepEqual(failure('{"_id":"a","_type":"t"}\n\ufeff{"_id":"b","_type":"t"}\n'), ['bom', 2]);
  assert.deepEqual(failure(`{"_id":"a","_type":"t","d":${'['.repeat(40)}${']'.repeat(40)}}\n`), ['depth_limit', 1]);
  assert.deepEqual(failure(`{"_id":"a","_type":"t","d":[${'1,'.repeat(2001)}1]}\n`), ['collection_limit', 1]);
  assert.deepEqual(failure(`{"_id":"a","_type":"t","d":"${'x'.repeat(100_001)}"}\n`), ['string_limit', 1]);
  assert.deepEqual(failure(`{"_id":"a","_type":"t","d":[${'[1],'.repeat(10_000)}1]}\n`), ['collection_limit', 1]);
  assert.deepEqual(failure(Uint8Array.from(Buffer.alloc(2 * 1024 * 1024, 120))), ['line_limit', 1]);
  const limited = text => { try { parseNdjson(enc(text), { limits: { maxDocuments: 1 } }); } catch (error) { return [error.code, error.line]; } return ['none', 0]; };
  assert.deepEqual(limited('{"_id":"a","_type":"t"}\n{"_id":"b","_type":"t"}\n'), ['record_limit', 2]);
  assert.throws(() => parseNdjson(enc('x'.repeat(100)), { limits: { maxTotalBytes: 10 } }), error => error.code === 'file_limit');
  assert.throws(() => parseNdjson('not bytes'), error => error.code === 'invalid_options');
  // Accepted: BOM on line 1, CRLF, blank and whitespace-only lines, no trailing newline.
  const ok = parseNdjson(enc('\ufeff{"_id":"a","_type":"t"}\r\n\r\n \t\n{"_id":"b","_type":"t"}'));
  assert.deepEqual([ok.documents.length, ok.stats.records, ok.stats.blanks], [2, 2, 2]);
});

test('errors carry fixed messages and only locator fields', () => {
  assert.equal(new CraftError('denied').message, 'Craft operation denied.');
  assert.equal(new CraftError('conflict', { documentId: 'x' }).documentId, 'x');
  assert.equal(new CraftError('validation_failed', { issues: [{ path: ['a'], code: 'required', message: 'm' }] }).message, 'Document failed validation.');
});

test('migration checksums ignore line endings and the shipped files load in order', async () => {
  assert.equal(migrationChecksum('a\nb\n'), migrationChecksum('a\r\nb\r\n'));
  assert.notEqual(migrationChecksum('a\nb\n'), migrationChecksum('a\nc\n'));
  const migrations = await loadMigrations();
  assert.deepEqual(migrations.map(m => m.name), ['0001_init.sql']);
  assert.match(migrations[0].checksum, /^[0-9a-f]{64}$/);
  await assert.rejects(() => loadMigrations('/definitely/not/a/dir'), error => error.code === 'migration_invalid');
});

test('createPgExecutor: BEGIN/COMMIT, ROLLBACK on error, snapshot isolation, broken clients are destroyed, errors propagate unchanged', async () => {
  const make = ({ failRollback = false } = {}) => {
    const log = []; const released = [];
    const client = { async query(text) { log.push(text); if (failRollback && text === 'ROLLBACK') throw new Error('rollback failed'); return { rows: [{ n: 1 }], rowCount: 1 }; }, release(arg) { released.push(arg); } };
    return { log, released, pool: { query: async (text, params) => { log.push(['pool', text, params]); return { rows: [], rowCount: null }; }, connect: async () => client } };
  };
  let h = make();
  const executor = createPgExecutor(h.pool);
  assert.deepEqual(await executor.query('SELECT 1', [1]), { rows: [], rowCount: 0 });
  assert.deepEqual(h.log[0], ['pool', 'SELECT 1', [1]]);
  h = make(); assert.equal(await createPgExecutor(h.pool).transaction(async tx => (await tx.query('SELECT 1')).rows[0].n), 1);
  assert.deepEqual(h.log, ['BEGIN', 'SELECT 1', 'COMMIT']); assert.deepEqual(h.released, [undefined]);
  h = make(); await assert.rejects(() => createPgExecutor(h.pool).transaction(async () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(h.log, ['BEGIN', 'ROLLBACK']); assert.deepEqual(h.released, [undefined]);
  h = make(); await createPgExecutor(h.pool).transaction(async () => 1, { snapshot: true });
  assert.equal(h.log[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  h = make({ failRollback: true }); await assert.rejects(() => createPgExecutor(h.pool).transaction(async () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(h.released, [true], 'a client that cannot roll back is discarded, not returned to the pool');
});

test('service entry points validate their context before touching the executor', async () => {
  const touched = [];
  const executor = { query: async t => { touched.push(t); return { rows: [], rowCount: 0 }; }, transaction: async () => { touched.push('tx'); return null; } };
  await assert.rejects(() => getDocument({ executor, actorId: 'a' }, { dataset: 'production', registry, documentId: 'x' }), e => e.code === 'invalid_input');
  await assert.rejects(() => getDocument({ executor, actorId: 'a', authorize: () => true }, { dataset: 'Bad Name', registry, documentId: 'x' }), e => e.code === 'invalid_input');
  await assert.rejects(() => getDocument({ executor, actorId: 'a', authorize: () => true }, { dataset: 'production', registry, documentId: 'bad id' }), e => e.code === 'invalid_input');
  assert.deepEqual(touched, []);
});
