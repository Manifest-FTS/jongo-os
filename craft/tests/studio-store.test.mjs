import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContentStudio, MutationKeys, StudioIdentity, duplicateDocument, formatClock, formatStamp, historyLabel, initialsOf, newMutationKey, safeAvatarUrl, settle, stableJson, statusDetail, statusLabel, unavailableFailure } from '../dist/index.js';
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
const hasItem = (html, id) => new RegExp(`<button[^>]*id="${id}"`).test(html);

test('store mode is opt-in: without a store the Studio keeps its exact local-draft wording', () => {
  const local = renderToStaticMarkup(createElement(ContentStudio, { config: { schemas: [schema], documents: [doc()] }, debug: true }));
  for (const text of ['Save local draft', 'Revert to original snapshot', 'persistence and publishing are not connected', 'page memory only']) assert.ok(local.includes(text), text);
  assert.ok(!local.includes('data-studio-mode'));
  for (const text of ['Publish</button>', 'Unpublish', 'Discard draft', 'Reload latest']) assert.ok(!local.includes(text), text);
  const plain = renderToStaticMarkup(createElement(ContentStudio, { config: { schemas: [schema], documents: [doc()] } }));
  assert.ok(plain.includes('Save local draft'), 'labels stay');
  for (const text of ['persistence and publishing are not connected', 'page memory only', 'Local draft mode: nothing is stored', 'Checks run locally', 'Drafts are kept in page memory']) assert.ok(!plain.includes(text), `not without debug: ${text}`);
});

test('connected Studio drops the not-connected notice and shows saved + Published status with only valid actions', () => {
  const html = render({ initial: { documents: [summary({ variant: 'published', hasPublished: true })], record: record({ variant: 'published', published: { nativeRev: 'r1', lockVersion: 3 } }) }, initialType: 'article', initialDocument: 'welcome' });
  for (const text of ['data-studio-mode="store"', 'data-save-state="saved"', 'data-doc-status="published"', 'Save draft', 'Unpublish', 'aria-live="polite"', 'Published and up to date', 'Published · article']) assert.ok(html.includes(text), text);
  for (const text of ['persistence and publishing are not connected', 'Save local draft', 'page memory only', 'Revert to original snapshot']) assert.ok(!html.includes(text), text);
  assert.ok(disabled(html, 'jongo-save'), 'nothing to save yet');
  assert.ok(disabled(html, 'jongo-publish'), 'a published document has nothing to publish');
  assert.ok(hasItem(html, 'jongo-unpublish') && !disabled(html, 'jongo-unpublish'));
  assert.ok(!hasItem(html, 'jongo-discard'), 'no draft to discard, so no menu item');
});

test('a draft over a published version offers publish (when valid) and discard, and labels itself Draft', () => {
  const html = render({ initial: { documents: [summary({ hasPublished: true })], record: record({ published: { nativeRev: 'r0', lockVersion: 2 } }) }, initialType: 'article', initialDocument: 'welcome' });
  assert.ok(html.includes('data-doc-status="draft"'));
  assert.ok(html.includes('Draft changes · article'));
  assert.ok(html.includes('this draft has changes that are not published'));
  assert.ok(!disabled(html, 'jongo-publish'));
  assert.ok(hasItem(html, 'jongo-discard') && !disabled(html, 'jongo-discard'));
  assert.ok(hasItem(html, 'jongo-unpublish') && !disabled(html, 'jongo-unpublish'));
  const same = render({ initial: { documents: [summary({ hasPublished: true })], record: record({ published: { nativeRev: 'r0', lockVersion: 2 }, publishedDiffers: false }) }, initialType: 'article', initialDocument: 'welcome' });
  assert.ok(!hasItem(same, 'jongo-discard'), 'a draft identical to the published version has nothing to discard');
});

test('a never-published draft cannot be unpublished or discarded; an invalid draft cannot be published and says why', () => {
  const html = render({ initial: { documents: [summary()], record: record({ doc: doc({ summary: undefined }) }) }, initialType: 'article', initialDocument: 'welcome' });
  assert.ok(html.includes('Never published'));
  assert.ok(html.includes('data-publish-ready="false"'));
  assert.ok(disabled(html, 'jongo-publish'));
  assert.ok(html.includes('Fix the blocking issues above to enable publishing.'));
  assert.ok(!hasItem(html, 'jongo-unpublish'));
  assert.ok(!hasItem(html, 'jongo-discard'));
});

test('failed prefetch renders an unavailable state with retry, never the local fallback; no prefetch shows loading', () => {
  const failed = render({ initial: { error: unavailableFailure('Storage is down.') }, initialType: 'article', debug: true });
  for (const text of ['role="alert"', 'Storage unavailable', 'Storage is down.', 'Try again', 'local drafts are not available while a store is connected']) assert.ok(failed.includes(text), text);
  assert.ok(!failed.includes('Save local draft'));
  const quiet = render({ initial: { error: unavailableFailure('Storage is down.') }, initialType: 'article' });
  assert.ok(quiet.includes('The document list could not be loaded.') && !quiet.includes('local drafts are not available'), 'the developer sentence needs debug');
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

// --- Editor panel: sticky header/footer, action menus, capabilities ---
const ok = async () => ({ ok: true });
const base = () => ({ list: ok, load: ok, saveDraft: ok, publish: ok, unpublish: ok, discardDraft: ok });
const published = record({ variant: 'published', published: { nativeRev: 'r1', lockVersion: 3 } });
const open = (storeObject, rec = published, config = { schemas: [schema], documents: [] }, extra = {}) => renderToStaticMarkup(createElement(ContentStudio, { config, store: storeObject, initial: { documents: [summary({ variant: rec.variant, hasPublished: rec.variant === 'published' || !!rec.published })], record: rec }, initialType: 'article', initialDocument: 'welcome', ...extra }));
const localHtml = (extra = {}) => renderToStaticMarkup(createElement(ContentStudio, { config: { schemas: [schema], documents: [doc()] }, ...extra }));

test('both modes drop the "Content workspace" label and render a sticky header and an action bar with accessible roles', () => {
  for (const html of [open(base(), published, undefined, { debug: true }), localHtml({ debug: true })]) {
    assert.ok(!html.includes('Content workspace'));
    for (const text of ['class="jongo-doc-header"', 'aria-label="Document header"', 'class="jongo-doc-footer"', 'role="group" aria-label="Document actions"', 'aria-label="Document tools"', 'aria-label="More actions"', 'aria-haspopup="menu"', 'aria-expanded="false"', 'aria-controls="jongo-more-menu"', 'aria-controls="jongo-tools-menu"', 'role="menu"', 'role="menuitem"']) {
      assert.ok(html.includes(text), text);
    }
    assert.ok(html.includes('Inspect') && html.includes('Copy document') && html.includes('data-issue-chip="clear"'));
    assert.ok(html.indexOf('class="jongo-doc-header"') < html.indexOf('jongo-editor-body') && html.indexOf('jongo-editor-body') < html.indexOf('class="jongo-doc-footer"'), 'header, body, footer order');
  }
  assert.ok(!/<details/.test(open(base())), 'the schema block moved into Inspect');
  // Inspect and Copy document (raw JSON, schema details) are developer tools: absent unless debug.
  for (const html of [open(base()), localHtml()]) assert.ok(!html.includes('Inspect') && !html.includes('Copy document'));
});

test('footer menu items follow the document state and the capabilities the store implements', () => {
  const none = open(base());
  assert.ok(hasItem(none, 'jongo-unpublish'));
  for (const id of ['jongo-duplicate', 'jongo-delete', 'jongo-history']) assert.ok(!hasItem(none, id), `${id} only with the store method`);
  const full = open({ ...base(), history: ok, duplicate: ok, delete: ok }, published, undefined, { debug: true });
  for (const id of ['jongo-unpublish', 'jongo-duplicate', 'jongo-delete', 'jongo-history', 'jongo-inspect', 'jongo-copy-document']) assert.ok(hasItem(full, id), id);
  assert.ok(/<button[^>]*id="jongo-delete"[^>]*class="jongo-menu-item jongo-menu-danger"|<button[^>]*class="jongo-menu-item jongo-menu-danger"[^>]*id="jongo-delete"/.test(full), 'destructive styling');
  assert.ok(/role="separator"[^>]*><\/div><button[^>]*id="jongo-delete"/.test(full), 'Delete is separated');
  const draftOnly = open({ ...base(), duplicate: ok, delete: ok }, record());
  assert.ok(!hasItem(draftOnly, 'jongo-unpublish') && !hasItem(draftOnly, 'jongo-discard') && hasItem(draftOnly, 'jongo-duplicate'));
});

test('singleton types hide Duplicate and Delete even when the store offers them', () => {
  const single = { schemas: [{ ...schema, singleton: true }], documents: [] };
  const html = open({ ...base(), duplicate: ok, delete: ok }, published, single);
  assert.ok(!hasItem(html, 'jongo-duplicate') && !hasItem(html, 'jongo-delete'));
  assert.ok(hasItem(html, 'jongo-unpublish'));
  assert.throws(() => content.createContentRegistry([{ ...schema, singleton: 'yes' }]), /Invalid/);
  assert.equal(content.createContentRegistry([{ ...schema, singleton: true }]).get('article').singleton, true);
});

test('permissions: view-only hides every write action and disables the fields; editors lose only publish, unpublish and delete; the default is everything', () => {
  const full = { ...base(), history: ok, duplicate: ok, delete: ok };
  const draftOverPublished = record({ published: { nativeRev: 'r0', lockVersion: 2 }, publishedDiffers: true });
  const all = open(full, draftOverPublished);
  for (const id of ['jongo-save', 'jongo-publish', 'jongo-duplicate', 'jongo-delete', 'jongo-discard', 'jongo-unpublish']) assert.ok(all.includes(`id="${id}"`), `${id} by default`);
  assert.ok(!all.includes('data-view-only') && !/<fieldset[^>]*disabled/.test(all));
  assert.equal(open(full, draftOverPublished, undefined, { permissions: {} }), all, 'an empty permissions object changes nothing');

  const reader = open(full, draftOverPublished, undefined, { permissions: { canWrite: false, canPublish: false } });
  for (const id of ['jongo-save', 'jongo-publish', 'jongo-duplicate', 'jongo-delete', 'jongo-discard', 'jongo-unpublish', 'jongo-reset']) assert.ok(!reader.includes(`id="${id}"`), `${id} hidden for a reader`);
  assert.ok(!reader.includes('id="jongo-more"'), 'no empty actions menu');
  assert.ok(/<fieldset[^>]*class="jongo-fields"[^>]*disabled|<fieldset[^>]*disabled[^>]*class="jongo-fields"/.test(reader), 'fields are disabled');
  assert.ok(reader.includes('data-view-only="true"') && reader.includes('view-only access'));
  assert.ok(!reader.includes('Upload image'), 'no upload controls');
  // canWrite false wins over canPublish true.
  assert.ok(!open(full, draftOverPublished, undefined, { permissions: { canWrite: false, canPublish: true } }).includes('id="jongo-publish"'));

  const editor = open(full, draftOverPublished, undefined, { permissions: { canWrite: true, canPublish: false } });
  for (const id of ['jongo-save', 'jongo-duplicate', 'jongo-discard']) assert.ok(editor.includes(`id="${id}"`), `${id} stays for an editor`);
  for (const id of ['jongo-publish', 'jongo-unpublish', 'jongo-delete']) assert.ok(!editor.includes(`id="${id}"`), `${id} hidden for an editor`);
  assert.ok(!/<fieldset[^>]*disabled/.test(editor) && !editor.includes('data-view-only'));
});

test('StudioIdentity shows the person and the role, with a picture only for an https address', () => {
  const html = renderToStaticMarkup(createElement(StudioIdentity, { person: { name: 'Ada Editor', email: 'ada@example.test', avatarUrl: 'https://cdn.example.test/a.png' }, roleLabel: 'Publisher' }));
  assert.ok(html.includes('data-identity-name="true">Ada Editor<') && html.includes('data-role-badge="true">Publisher<') && html.includes('src="https://cdn.example.test/a.png"'));
  assert.ok(!html.includes('jongo-role-elevated'));
  const elevated = renderToStaticMarkup(createElement(StudioIdentity, { person: { email: 'root@example.test', avatarUrl: 'http://cdn.example.test/a.png' }, roleLabel: 'Jongo Super Admin', elevated: true }));
  assert.ok(elevated.includes('>root@example.test<') && elevated.includes('jongo-role-elevated') && !elevated.includes('<img'), 'falls back to the email and to initials');
  assert.ok(renderToStaticMarkup(createElement(StudioIdentity, { person: {}, roleLabel: 'Reader' })).includes('>Signed in<'));
});

test('icons are decorative and every icon button has an accessible name', () => {
  for (const html of [open({ ...base(), history: ok, duplicate: ok, delete: ok }, published, undefined, { debug: true }), localHtml({ debug: true })]) {
    const svgs = html.match(/<svg\b[^>]*>/g) ?? [];
    assert.ok(svgs.length >= 5);
    for (const svg of svgs) assert.ok(svg.includes('aria-hidden="true"') && svg.includes('focusable="false"'), svg);
    for (const trigger of html.match(/<button[^>]*class="jongo-icon-button"[^>]*>/g) ?? []) assert.ok(/aria-label="[^"]+"/.test(trigger), trigger);
  }
});

test('local mode keeps its exact labels inside the menu and offers no store actions', () => {
  const html = localHtml({ debug: true });
  for (const text of ['Save local draft', 'Reset changes', 'Revert to original snapshot', 'id="jongo-reset"', 'id="jongo-revert"', 'role="menuitem"']) assert.ok(html.includes(text), text);
  for (const text of ['Unpublish', 'Discard draft', 'Duplicate', 'Delete', 'History', 'Publish</button>']) assert.ok(!html.includes(text), text);
  assert.ok(disabled(html, 'jongo-reset') && disabled(html, 'jongo-revert'), 'nothing to reset yet');
  assert.ok(html.includes('Local draft mode: nothing is stored'));
});

test('footer status shows who and when from the store, with a safe avatar; header chip counts issues', () => {
  const by = { id: 'studio', name: 'Craft session' };
  const html = open(base(), { ...published, lastPublished: { at: '2026-08-17T14:32:10.000Z', by } });
  assert.ok(html.includes('Published <time dateTime="2026-08-17T14:32:10.000Z">17 Aug 2026, 14:32 UTC</time> \u00b7 Craft session'), 'status text');
  assert.ok(html.includes('<span class="jongo-avatar" aria-hidden="true">CS</span>'), 'initials chip');
  const photo = open(base(), { ...published, lastPublished: { at: '2026-08-17T14:32:10.000Z', by: { ...by, avatarUrl: 'https://img.example.com/a.png' } } });
  assert.ok(photo.includes('<img src="https://img.example.com/a.png" alt=""'));
  for (const bad of ['javascript:alert(1)', 'http://img.example.com/a.png', 'data:image/png;base64,AAAA', '//img.example.com/a.png', 'https://user:pw@img.example.com/a.png']) {
    const unsafe = open(base(), { ...published, lastPublished: { at: '2026-08-17T14:32:10.000Z', by: { ...by, avatarUrl: bad } } });
    assert.ok(!unsafe.includes('<img src=') && unsafe.includes('>CS<'), bad);
  }
  const noWho = open(base(), { ...published, lastPublished: { at: '2026-08-17T14:32:10.000Z' } });
  assert.ok(noWho.includes('Published <time') && !noWho.includes('jongo-avatar'));
  const draft = open(base(), record({ lastEdited: { at: '2026-08-17T09:05:00.000Z', by } }));
  assert.ok(draft.includes('Draft saved <time dateTime="2026-08-17T09:05:00.000Z">17 Aug 2026, 09:05 UTC</time>'));
  const invalid = open(base(), record({ doc: doc({ summary: undefined }) }));
  assert.ok(invalid.includes('data-issue-chip="error"') && />1 issue</.test(invalid));
});

test('pure display helpers: stamps, clocks, initials, avatar URLs, history labels', () => {
  assert.equal(formatStamp('2026-08-17T14:32:10.000Z', 'UTC'), '17 Aug 2026, 14:32');
  assert.equal(formatStamp('2026-08-17T14:32:10.000Z', 'America/Chicago'), '17 Aug 2026, 09:32');
  assert.equal(formatClock('2026-08-17T14:32:10.000Z', 'UTC'), '14:32');
  assert.equal(formatStamp('not a date'), ''); assert.equal(formatClock('x'), '');
  assert.equal(initialsOf('Craft session'), 'CS'); assert.equal(initialsOf('ada'), 'A'); assert.equal(initialsOf('  '), ''); assert.equal(initialsOf(undefined), '');
  assert.equal(safeAvatarUrl('https://a.example/x.png'), 'https://a.example/x.png');
  for (const bad of [undefined, 5, '', 'http://a.example/x', 'javascript:alert(1)', 'ftp://a.example', 'https://u:p@a.example/', `https://a.example/${'x'.repeat(2100)}`]) assert.equal(safeAvatarUrl(bad), undefined, String(bad));
  assert.equal(historyLabel('publish'), 'Published'); assert.equal(historyLabel('delete'), 'Deleted'); assert.equal(historyLabel('__proto__'), 'Changed'); assert.equal(historyLabel('new-thing'), 'Changed');
});

test('duplicateDocument: deep copy without envelope or id, " (copy)" on the title within its length limit, never aliasing the source', () => {
  const source = { _id: 'a', _type: 'article', _rev: 'r', _createdAt: 'x', _updatedAt: 'y', title: 'Hello', summary: 'S', nested: { list: [1, { k: 'v' }] } };
  const copy = duplicateDocument(source, schema);
  assert.deepEqual(copy, { _type: 'article', title: 'Hello (copy)', summary: 'S', nested: { list: [1, { k: 'v' }] } });
  copy.nested.list[1].k = 'changed';
  assert.equal(source.nested.list[1].k, 'v');
  assert.equal(source.title, 'Hello');
  const long = duplicateDocument({ _id: 'b', _type: 'article', title: 'A'.repeat(20) }, schema);
  assert.equal(long.title.length, 20); assert.ok(long.title.endsWith(' (copy)'));
  assert.equal(duplicateDocument({ _id: 'c', _type: 'article', title: '  ' }, schema).title, '  ', 'no text, no suffix');
  assert.equal(duplicateDocument({ _id: 'd', _type: 'other', count: 1 }).count, 1);
  assert.equal(Object.hasOwn(duplicateDocument({ _id: 'e', _type: 'article', title: 'x' }, schema), '_id'), false);
});
