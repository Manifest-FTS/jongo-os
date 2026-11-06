import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContentStudio, MAX_IMAGE_BYTES, settleUpload, uploadAsset } from '../dist/index.js';

const file = (name = 'Range Photo.png', type = 'image/png', size = 4321) => ({ name, type, size });
const ticket = { ok: true, uploadUrl: 'https://s3.example/jongo-craft/k?X-Amz-Signature=x', headers: { 'content-type': 'image/png' }, key: 'p/assets/images/2026/11/0a1b2c3d-range-photo.png', token: 't.1', expiresAt: '2026-11-05T12:35:15.000Z', contentType: 'image/png', size: 4321 };
const asset = { _id: 'image-1', _type: 'sanity.imageAsset', url: 'https://cdn.example/k', size: 4321, originalFilename: 'Range Photo.png' };
function fakeStore(overrides = {}) {
  const calls = [];
  return { calls, requestUpload: async input => { calls.push(['request', input]); return ticket; }, completeUpload: async input => { calls.push(['complete', input]); return { ok: true, asset }; }, ...overrides };
}
const put = (calls, result = { ok: true }) => async (given, blob, handlers) => { calls.push(['put', given.uploadUrl, given.headers]); handlers.onProgress?.(0.5); return result; };

test('upload: request a ticket, PUT straight to storage, then ask the host to verify; progress is reported', async () => {
  const store = fakeStore(), progress = [];
  const result = await uploadAsset(store, file(), { onProgress: value => progress.push(value) }, { put: put(store.calls) });
  assert.deepEqual(result, { ok: true, asset });
  assert.deepEqual(store.calls.map(call => call[0]), ['request', 'put', 'complete']);
  assert.deepEqual(store.calls[0][1], { filename: 'Range Photo.png', contentType: 'image/png', size: 4321 }, 'the browser sends only name, type and size');
  assert.equal(store.calls[1][1], ticket.uploadUrl);
  assert.deepEqual(store.calls[2][1], { key: ticket.key, token: ticket.token, contentType: 'image/png', size: 4321, filename: 'Range Photo.png' }, 'the proof from the ticket comes back');
  assert.deepEqual(progress, [0.5, 1]);
});

test('upload: type and size are refused before any network call, with typed codes', async () => {
  for (const [candidate, code] of [[file('x.svg', 'image/svg+xml'), 'type_not_allowed'], [file('x.exe', 'application/x-msdownload'), 'type_not_allowed'], [file('x.png', ''), 'type_not_allowed'], [file('big.png', 'image/png', MAX_IMAGE_BYTES + 1), 'too_large'], [file('e.png', 'image/png', 0), 'empty']]) {
    const store = fakeStore();
    const result = await uploadAsset(store, candidate, {}, { put: put(store.calls) });
    assert.deepEqual([result.ok, result.code], [false, code], candidate.name);
    assert.equal(store.calls.length, 0, 'nothing was requested');
    assert.ok(result.message.length > 10);
  }
  const small = fakeStore();
  assert.equal((await uploadAsset(small, file('a.png', 'image/png', 2000), {}, { put: put(small.calls), limits: { maxImageBytes: 1000, maxVideoBytes: 5000 } })).code, 'too_large', 'host limits apply');
  assert.match((await uploadAsset(small, file('big.png', 'image/png', MAX_IMAGE_BYTES + 1))).message, /15 MB/);
});

test('upload: every failure is typed, nothing throws, and a failed PUT never asks for verification', async () => {
  const noMethods = await uploadAsset({}, file());
  assert.deepEqual([noMethods.ok, noMethods.code], [false, 'unavailable']);
  const denied = fakeStore({ requestUpload: async () => ({ ok: false, code: 'denied', message: 'Sign in again.' }) });
  assert.deepEqual(await uploadAsset(denied, file(), {}, { put: put(denied.calls) }), { ok: false, code: 'denied', message: 'Sign in again.' });
  const missing = fakeStore({ requestUpload: async () => ({ ok: false, code: 'unavailable', message: 'Uploading is not available right now.', missing: ['JONGO_CRAFT_B2_BUCKET'] }) });
  assert.deepEqual((await uploadAsset(missing, file())).missing, ['JONGO_CRAFT_B2_BUCKET']);
  const throws = fakeStore({ requestUpload: async () => { throw new Error('SELECT secret'); } });
  const thrown = await uploadAsset(throws, file());
  assert.deepEqual([thrown.ok, thrown.code], [false, 'unavailable']);
  assert.ok(!JSON.stringify(thrown).includes('secret'));
  const failedPut = fakeStore();
  assert.equal((await uploadAsset(failedPut, file(), {}, { put: put(failedPut.calls, { ok: false }) })).code, 'upload_failed');
  assert.ok(!failedPut.calls.some(call => call[0] === 'complete'));
  const brokenPut = fakeStore();
  assert.equal((await uploadAsset(brokenPut, file(), {}, { put: async () => { throw new Error('network'); } })).code, 'upload_failed');
  const cancelled = fakeStore();
  assert.equal((await uploadAsset(cancelled, file(), {}, { put: put(cancelled.calls, { ok: false, cancelled: true }) })).code, 'cancelled');
  assert.ok(!cancelled.calls.some(call => call[0] === 'complete'));
  const unverified = fakeStore({ completeUpload: async () => ({ ok: false, code: 'verify_failed', message: 'The file was uploaded but could not be verified.' }) });
  assert.equal((await uploadAsset(unverified, file(), {}, { put: put(unverified.calls) })).code, 'verify_failed');
  const weird = fakeStore({ completeUpload: async () => ({ ok: false, code: 'something_new', message: '' }) });
  const normalised = await uploadAsset(weird, file(), {}, { put: put(weird.calls) });
  assert.deepEqual([normalised.code, normalised.message.length > 5], ['unavailable', true]);
});

test('upload: an aborted signal stops before the request and before verification', async () => {
  const early = new AbortController(); early.abort();
  const store = fakeStore();
  assert.equal((await uploadAsset(store, file(), { signal: early.signal }, { put: put(store.calls) })).code, 'cancelled');
  assert.equal(store.calls.length, 0);
  const late = new AbortController();
  const during = fakeStore({ requestUpload: async () => { late.abort(); return ticket; } });
  assert.equal((await uploadAsset(during, file(), { signal: late.signal }, { put: put(during.calls) })).code, 'cancelled');
  assert.ok(!during.calls.some(call => call[0] === 'put'));
});

test('settleUpload never rejects', async () => {
  assert.deepEqual((await settleUpload(async () => { throw new Error('x'); })).code, 'unavailable');
  assert.deepEqual((await settleUpload(async () => undefined)).code, 'unavailable');
  assert.deepEqual(await settleUpload(async () => ({ ok: true, a: 1 })), { ok: true, a: 1 });
});

test('the Studio renders with an upload-capable store, and Upload lives in the picker dialog only', () => {
  const schema = { name: 'page', title: 'Pages', type: 'document', schemaVersion: 1, fields: [{ name: 'title', type: 'string' }, { name: 'photo', type: 'image', altRequired: true }] };
  const rec = { doc: { _id: 'p1', _type: 'page', title: 'T', _rev: 'r' }, nativeRev: 'r', lockVersion: 1, variant: 'draft' };
  const uploadStore = { list: async () => ({ ok: true, documents: [] }), load: async () => ({ ok: false }), saveDraft: async () => ({ ok: false }), publish: async () => ({ ok: false }), unpublish: async () => ({ ok: false }), discardDraft: async () => ({ ok: false }), listAssets: async () => ({ ok: true, assets: [] }), requestUpload: async () => ticket, completeUpload: async () => ({ ok: true, asset }) };
  const html = renderToStaticMarkup(createElement(ContentStudio, { config: { schemas: [schema], documents: [] }, store: uploadStore, initial: { documents: [{ id: 'p1', type: 'page', title: 'T', variant: 'draft', hasPublished: false }], record: rec, assets: [asset] }, initialType: 'page', initialDocument: 'p1' }));
  assert.ok(html.includes('id="jongo-p1-photo.pick"') && html.includes('Alternative text'));
  assert.ok(!html.includes('Upload image'), 'the dialog (and its Upload button) opens on demand');
});
