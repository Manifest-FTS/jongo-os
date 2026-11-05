import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContentStudio, MutationKeys, newMutationKey, settle, stableJson, statusDetail, statusLabel, unavailableFailure } from '../dist/index.js';
import * as content from '../dist/content.js';

const schema = { name: 'article', title: 'Articles', type: 'document', schemaVersion: 1, fields: [
  { name: 'title', title: 'Title', type: 'string', required: true, maxLength: 20 },
  { name: 'summary', title: 'Summary', type: 'string', publishRequired: true }
] };
const doc = (extra = {}) => ({ _id: 'welcome', _type: 'article', title: 'Hello', summary: 'Library news', _rev: 'r1', ...extra });
const summary = (extra = {}) => ({ id: 'welcome', type: 'article', title: 'Hello', variant: 'draft', hasPublished: false, ...extra });
const record = (extra = {}) => ({ doc: doc(), nativeRev: 'r1', lockVersion: 3, variant: 'draft', ...extra });
const store = new Proxy({}, { get: () => async () => ({ ok: false, code: 'unavailable', message: 'x' }) });
const render = props => renderToStaticMarkup(createElement(ContentStudio, { config: { schemas: [schema], documents: [] }, store, ...props }));
const button = (html, id) => html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))?.[0] ?? assert.fail(`no ${id} button`);
const disabled = (html, id) => /disabled=""/.test(button(html, id));

test('store mode is opt-in: without a store the Studio keeps its exact local-draft wording', () => {
  const local = renderToStaticMarkup(createElement(ContentStudio, { config: { schemas: [schema], documents: [doc()] } }));
  for (const text of ['Save local draft', 'Revert to original snapshot', 'persistence and publishing are not connected', 'page memory only']) assert.ok(local.includes(text), text);
  assert.ok(!local.includes('data-studio-mode'));
  for (const text of ['Publish</button>', 'Unpublish', 'Discard draft', 'Reload latest']) assert.ok(!local.includes(text), text);
});

test('connected Studio drops the not-connected notice and shows saved + Published status with only valid actions', () => {
  const html = render({ initial: { documents: [summary({ variant: 'published', hasPublished: true })], record: record({ variant: 'published', published: { nativeRev: 'r1', lockVersion: 3 } }) }, initialType: 'article', initialDocument: 'welcome' });
  for (const text of ['data-studio-mode="store"', 'data-save-state="saved"', 'data-doc-status="published"', 'Save draft', 'Unpublish', 'Discard draft', 'aria-live="polite"', 'Published and up to date', 'Published · article']) assert.ok(html.includes(text), text);
  for (const text of ['persistence and publishing are not connected', 'Save local draft', 'page memory only', 'Revert to original snapshot']) assert.ok(!html.includes(text), text);
  assert.ok(disabled(html, 'jongo-save'), 'nothing to save yet');
  assert.ok(disabled(html, 'jongo-publish'), 'a published document has nothing to publish');
  assert.ok(!disabled(html, 'jongo-unpublish'));
  assert.ok(disabled(html, 'jongo-discard'), 'no draft to discard');
});

test('a draft over a published version offers publish (when valid) and discard, and labels itself Draft', () => {
  const html = render({ initial: { documents: [summary({ hasPublished: true })], record: record({ published: { nativeRev: 'r0', lockVersion: 2 } }) }, initialType: 'article', initialDocument: 'welcome' });
  assert.ok(html.includes('data-doc-status="draft"'));
  assert.ok(html.includes('Draft changes · article'));
  assert.ok(html.includes('this draft has changes that are not published'));
  assert.ok(!disabled(html, 'jongo-publish'));
  assert.ok(!disabled(html, 'jongo-discard'));
  assert.ok(!disabled(html, 'jongo-unpublish'));
});

test('a never-published draft cannot be unpublished or discarded; an invalid draft cannot be published and says why', () => {
  const html = render({ initial: { documents: [summary()], record: record({ doc: doc({ summary: undefined }) }) }, initialType: 'article', initialDocument: 'welcome' });
  assert.ok(html.includes('Never published'));
  assert.ok(html.includes('data-publish-ready="false"'));
  assert.ok(disabled(html, 'jongo-publish'));
  assert.ok(html.includes('Fix the blocking issues above to enable publishing.'));
  assert.ok(disabled(html, 'jongo-unpublish'));
  assert.ok(disabled(html, 'jongo-discard'));
});

test('failed prefetch renders an unavailable state with retry, never the local fallback; no prefetch shows loading', () => {
  const failed = render({ initial: { error: unavailableFailure('Storage is down.') }, initialType: 'article' });
  for (const text of ['role="alert"', 'Storage unavailable', 'Storage is down.', 'Try again', 'Local drafts are not available while a store is connected']) assert.ok(failed.includes(text), text);
  assert.ok(!failed.includes('Save local draft'));
  const denied = render({ initial: { error: { ok: false, code: 'denied', message: 'Session ended.' } }, signInHref: '/craft/login' });
  assert.ok(denied.includes('href="/craft/login"') && denied.includes('Sign in again'));
  const loading = render({});
  assert.ok(loading.includes('Loading…'));
});

test('notice, top-bar slot and brand render in both modes without changing local semantics', () => {
  const slot = createElement('form', { id: 'out' }, 'Sign out');
  const connected = render({ notice: 'Public pages are unchanged.', topbarSlot: slot, initial: { documents: [] } });
  const local = renderToStaticMarkup(createElement(ContentStudio, { config: { schemas: [schema], documents: [doc()] }, notice: 'LOCAL DRAFT MODE: DATABASE_URL is not set.', topbarSlot: slot }));
  for (const html of [connected, local]) assert.ok(html.includes('id="out"') && html.includes('role="note"'));
  assert.ok(connected.includes('Public pages are unchanged.') && connected.includes('No documents of this type are stored yet.'));
  assert.ok(local.includes('LOCAL DRAFT MODE: DATABASE_URL is not set.') && local.includes('Save local draft'));
});

test('studio-store contract is pure and exported from the no-React content entry too', () => {
  for (const name of ['MutationKeys', 'newMutationKey', 'settle', 'stableJson', 'unavailableFailure', 'statusLabel']) assert.equal(typeof content[name], 'function', name);
  assert.equal(content.ContentStudio, undefined);
  assert.equal(statusLabel({ variant: 'published' }), 'Published');
  assert.equal(statusLabel({ variant: 'draft' }), 'Draft');
  assert.match(statusDetail({ variant: 'draft', published: { nativeRev: 'a', lockVersion: 1 } }), /not published/);
});

test('mutation keys: valid for the server alphabet, stable across an identical retry, new for any change', () => {
  const key = newMutationKey('save');
  assert.match(key, /^[A-Za-z0-9._:/@+=~-]{1,128}$/);
  assert.notEqual(newMutationKey('save'), key);
  const keys = new MutationKeys();
  const body = { _id: 'a', _type: 'article', title: 'T', nested: { b: 1, a: 2 } };
  const first = keys.keyFor('save', 'a', { nativeRev: 'r1', lockVersion: 1 }, body);
  assert.equal(keys.keyFor('save', 'a', { nativeRev: 'r1', lockVersion: 1 }, { nested: { a: 2, b: 1 }, title: 'T', _type: 'article', _id: 'a' }), first, 'same content, key order irrelevant');
  assert.notEqual(keys.keyFor('save', 'a', { nativeRev: 'r1', lockVersion: 1 }, { ...body, title: 'U' }), first, 'different body');
  const second = keys.keyFor('save', 'a', { nativeRev: 'r1', lockVersion: 1 }, { ...body, title: 'U' });
  assert.notEqual(keys.keyFor('save', 'a', { nativeRev: 'r2', lockVersion: 1 }, { ...body, title: 'U' }), second, 'different precondition');
  const third = keys.keyFor('publish', 'a', { nativeRev: 'r2', lockVersion: 1 });
  assert.notEqual(keys.keyFor('unpublish', 'a', { nativeRev: 'r2', lockVersion: 1 }), third, 'different operation');
  const fourth = keys.keyFor('discard', 'a', { nativeRev: 'r2', lockVersion: 1 });
  keys.clear();
  assert.notEqual(keys.keyFor('discard', 'a', { nativeRev: 'r2', lockVersion: 1 }), fourth, 'cleared after a confirmed outcome');
  assert.equal(stableJson({ b: [1, { d: undefined, c: 'x' }], a: null }), '{"a":null,"b":[1,{"c":"x"}]}');
});

test('settle turns throws, rejections and malformed results into typed unavailable failures and keeps real ones', async () => {
  const unavailable = result => { assert.equal(result.ok, false); assert.equal(result.code, 'unavailable'); assert.ok(result.message.length > 0); };
  unavailable(await settle(async () => { throw new Error('SELECT secret FROM users'); }));
  unavailable(await settle(() => Promise.reject(new Error('boom'))));
  unavailable(await settle(async () => undefined));
  unavailable(await settle(async () => ({ nope: true })));
  unavailable(await settle(async () => ({ ok: false, code: 'weird', message: 'x' })));
  const conflict = await settle(async () => ({ ok: false, code: 'conflict', message: 'changed', fieldErrors: [{ path: ['title'], message: 'm' }] }));
  assert.deepEqual(conflict, { ok: false, code: 'conflict', message: 'changed', fieldErrors: [{ path: ['title'], message: 'm' }] });
  const ok = await settle(async () => ({ ok: true, documents: [] }));
  assert.deepEqual(ok, { ok: true, documents: [] });
  assert.ok(!JSON.stringify(await settle(async () => { throw new Error('SELECT secret'); })).includes('secret'));
});
