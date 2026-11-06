import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContentStudio, MutationKeys, planPublish, saveThenPublish } from '../dist/index.js';

const schema = { name: 'article', title: 'Articles', type: 'document', schemaVersion: 1, fields: [
  { name: 'title', title: 'Title', type: 'string', required: true, maxLength: 20 },
  { name: 'summary', title: 'Summary', type: 'string', publishRequired: true }
] };
const doc = (extra = {}) => ({ _id: 'welcome', _type: 'article', title: 'Hello', summary: 'Library news', _rev: 'r1', ...extra });
const summaryOf = (extra = {}) => ({ id: 'welcome', type: 'article', title: 'Hello', variant: 'draft', hasPublished: false, ...extra });
const record = (extra = {}) => ({ doc: doc(), nativeRev: 'r1', lockVersion: 3, variant: 'draft', ...extra });
const ok = async () => ({ ok: true });
const fullStore = { list: ok, load: ok, saveDraft: ok, publish: ok, unpublish: ok, discardDraft: ok, history: ok, duplicate: ok, delete: ok };
const connected = (rec, extra = {}, config = { schemas: [schema], documents: [] }) => renderToStaticMarkup(createElement(ContentStudio, {
  config, store: fullStore, initial: { documents: [summaryOf({ variant: rec.variant, hasPublished: rec.variant === 'published' || !!rec.published })], record: rec }, initialType: 'article', initialDocument: 'welcome', ...extra
}));
const local = (extra = {}, config = { schemas: [schema], documents: [doc()] }) => renderToStaticMarkup(createElement(ContentStudio, { config, ...extra }));

const tag = (html, id) => html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))?.[0];
/** 'hidden' (not rendered), 'disabled' or 'enabled'. */
const stateOf = (html, id) => { const found = tag(html, id); return !found ? 'hidden' : /disabled=""/.test(found) ? 'disabled' : 'enabled'; };
const reasonOf = html => { const match = html.match(/data-publish-reason="([a-z]+)">([^<]*)</); return match ? { kind: match[1], text: match[2] } : null; };
const ACTIONS = { save: 'jongo-save', publish: 'jongo-publish', unpublish: 'jongo-unpublish', discard: 'jongo-discard', duplicate: 'jongo-duplicate', delete: 'jongo-delete' };
const matrixOf = html => Object.fromEntries(Object.entries(ACTIONS).map(([name, id]) => [name, stateOf(html, id)]));

const PUBLISHED = { nativeRev: 'r0', lockVersion: 2 };
const noSummary = doc({ summary: undefined });
const twoIssues = doc({ summary: undefined, title: 'T'.repeat(21) });

test('action matrix, connected, publisher: every initial state shows the right actions, and a visible reason when Publish is disabled', () => {
  const rows = [
    ['draft, clean, valid', record(), { save: 'disabled', publish: 'enabled', unpublish: 'hidden', discard: 'hidden', duplicate: 'enabled', delete: 'enabled' }, null],
    ['draft, invalid', record({ doc: noSummary }), { save: 'disabled', publish: 'disabled', unpublish: 'hidden', discard: 'hidden', duplicate: 'enabled', delete: 'enabled' }, { kind: 'blocked', text: 'Fix 1 issue to publish' }],
    ['draft, two issues', record({ doc: twoIssues }), { save: 'disabled', publish: 'disabled', unpublish: 'hidden', discard: 'hidden', duplicate: 'enabled', delete: 'enabled' }, { kind: 'blocked', text: 'Fix 2 issues to publish' }],
    ['published, clean', record({ variant: 'published', published: { nativeRev: 'r1', lockVersion: 3 } }), { save: 'disabled', publish: 'disabled', unpublish: 'enabled', discard: 'hidden', duplicate: 'enabled', delete: 'enabled' }, { kind: 'current', text: 'Published, up to date' }],
    ['published, clean but no longer valid: nothing to publish wins over the issue', record({ variant: 'published', doc: noSummary, published: { nativeRev: 'r1', lockVersion: 3 } }), { save: 'disabled', publish: 'disabled', unpublish: 'enabled', discard: 'hidden', duplicate: 'enabled', delete: 'enabled' }, { kind: 'current', text: 'Published, up to date' }],
    ['draft over published (differs)', record({ published: PUBLISHED, publishedDiffers: true }), { save: 'disabled', publish: 'enabled', unpublish: 'enabled', discard: 'enabled', duplicate: 'enabled', delete: 'enabled' }, null],
    ['draft over published (differs unknown)', record({ published: PUBLISHED }), { save: 'disabled', publish: 'enabled', unpublish: 'enabled', discard: 'enabled', duplicate: 'enabled', delete: 'enabled' }, null],
    ['draft identical to published: Publish still clears the draft, Discard has nothing to drop', record({ published: PUBLISHED, publishedDiffers: false }), { save: 'disabled', publish: 'enabled', unpublish: 'enabled', discard: 'hidden', duplicate: 'enabled', delete: 'enabled' }, null],
    ['draft over published, invalid', record({ doc: noSummary, published: PUBLISHED, publishedDiffers: true }), { save: 'disabled', publish: 'disabled', unpublish: 'enabled', discard: 'enabled', duplicate: 'enabled', delete: 'enabled' }, { kind: 'blocked', text: 'Fix 1 issue to publish' }]
  ];
  for (const [name, rec, expected, reason] of rows) {
    const html = connected(rec);
    assert.deepEqual(matrixOf(html), expected, name);
    assert.deepEqual(reasonOf(html), reason, `${name}: visible reason`);
    const publish = tag(html, 'jongo-publish');
    if (reason) {
      assert.ok(publish.includes('aria-describedby="jongo-publish-reason"') && html.includes('id="jongo-publish-reason"'), `${name}: described by the visible reason`);
      assert.ok(html.includes(`title="${reason.text}"`), `${name}: the same text as a tooltip`);
    } else assert.ok(!publish.includes('aria-describedby') && !html.includes('jongo-publish-reason'), `${name}: no reason when Publish is enabled`);
  }
});

test('an invalid draft: the reason is a button that jumps to the first issue; the other reasons are plain text', () => {
  const blocked = connected(record({ doc: noSummary }));
  assert.match(blocked, /<button id="jongo-publish-reason" type="button" class="jongo-link jongo-footer-reason" data-publish-reason="blocked">Fix 1 issue to publish<\/button>/);
  assert.ok(blocked.includes('data-issue-chip="error"'), 'the header chip stays');
  assert.match(connected(record({ variant: 'published', published: { nativeRev: 'r1', lockVersion: 3 } })), /<span id="jongo-publish-reason" class="jongo-footer-reason" data-publish-reason="current">Published, up to date<\/span>/);
  assert.ok(!connected(record()).includes('jongo-publish-hint'), 'no screen-reader-only substitute any more');
});

test('action matrix, connected, by role: reader sees nothing to change, editor cannot publish, unpublish or delete, and each says why', () => {
  const draftOverPublished = record({ published: PUBLISHED, publishedDiffers: true });
  const reader = connected(draftOverPublished, { permissions: { canWrite: false, canPublish: false } });
  assert.deepEqual(matrixOf(reader), { save: 'hidden', publish: 'hidden', unpublish: 'hidden', discard: 'hidden', duplicate: 'hidden', delete: 'hidden' });
  assert.equal(reasonOf(reader), null);
  assert.ok(reader.includes('data-view-only="true"') && !reader.includes('data-edit-only') && !reader.includes('id="jongo-more"'));

  const editor = connected(draftOverPublished, { permissions: { canWrite: true, canPublish: false } });
  assert.deepEqual(matrixOf(editor), { save: 'disabled', publish: 'hidden', unpublish: 'hidden', discard: 'enabled', duplicate: 'enabled', delete: 'hidden' });
  assert.equal(reasonOf(editor), null, 'no Publish button, so no Publish reason');
  assert.ok(editor.includes('data-edit-only="true"') && editor.includes('Publishing, unpublishing and deleting need publisher access.') && !editor.includes('data-view-only'));

  const publisher = connected(draftOverPublished, { permissions: { canWrite: true, canPublish: true } });
  assert.deepEqual(matrixOf(publisher), { save: 'disabled', publish: 'enabled', unpublish: 'enabled', discard: 'enabled', duplicate: 'enabled', delete: 'enabled' });
  assert.ok(!publisher.includes('data-edit-only') && !publisher.includes('data-view-only'));
  assert.equal(publisher, connected(draftOverPublished), 'publisher equals the default');
});

test('planPublish: dirty, busy and conflict states (not reachable from a server render) and the order of reasons', () => {
  const base = { variant: 'draft', dirty: false, errors: 0, busy: false, stale: false };
  assert.deepEqual(planPublish(base), { can: true, saveFirst: false });
  assert.deepEqual(planPublish({ ...base, dirty: true }), { can: true, saveFirst: true }, 'draft + unsaved edits: Publish saves first');
  assert.deepEqual(planPublish({ ...base, variant: 'published', dirty: true }), { can: true, saveFirst: true }, 'published + unsaved edits: Publish saves first');
  assert.deepEqual(planPublish({ ...base, variant: 'published' }), { can: false, reason: 'current', text: 'Published, up to date' });
  assert.deepEqual(planPublish({ ...base, errors: 1 }), { can: false, reason: 'blocked', text: 'Fix 1 issue to publish' });
  assert.deepEqual(planPublish({ ...base, dirty: true, errors: 3 }), { can: false, reason: 'blocked', text: 'Fix 3 issues to publish' });
  assert.deepEqual(planPublish({ ...base, variant: 'published', dirty: true, errors: 2 }), { can: false, reason: 'blocked', text: 'Fix 2 issues to publish' });
  assert.deepEqual(planPublish({ ...base, busy: true }), { can: false, reason: 'busy', text: '' }, 'busy shows no reason text');
  assert.equal(planPublish({ ...base, busy: true, stale: true, errors: 2, variant: 'published' }).reason, 'busy', 'busy wins');
  assert.deepEqual(planPublish({ ...base, dirty: true, stale: true }), { can: false, reason: 'stale', text: 'Reload latest to continue' }, 'a conflict blocks Publish until Reload latest');
  assert.equal(planPublish({ ...base, variant: 'published', stale: true, errors: 1 }).reason, 'stale', 'stale wins over nothing-to-publish and issues');
});

// --- Save-then-publish orchestration against a fake store ---
const rec = (nativeRev, lockVersion, extra = {}) => ({ ok: true, doc: doc({ _rev: nativeRev }), nativeRev, lockVersion, variant: 'draft', ...extra });
function fakeStore(script) {
  const calls = [];
  const next = name => { const queue = script[name]; return queue.length > 1 ? queue.shift() : queue[0]; };
  return {
    calls,
    async saveDraft(document, expect) { calls.push({ op: 'save', document, expect }); return next('save'); },
    async publish(id, expect) { calls.push({ op: 'publish', id, expect }); return next('publish'); }
  };
}
const edited = doc({ title: 'Edited' });
const head = { nativeRev: 'r1', lockVersion: 3 };
const lost = { ok: false, code: 'unavailable', message: 'Jongo Craft could not reach storage. Nothing was confirmed as saved; try again.' };

test('save then publish: save with the head precondition, then publish with the NEW revision, in that order, each with its own key', async () => {
  const store = fakeStore({ save: [rec('r2', 4)], publish: [rec('r3', 1, { variant: 'published' })] });
  const keys = new MutationKeys();
  const outcome = await saveThenPublish(store, { id: 'welcome', expect: head, doc: edited, keys });
  assert.equal(outcome.ok, true);
  assert.deepEqual(store.calls.map(call => call.op), ['save', 'publish']);
  assert.deepEqual([store.calls[0].expect.nativeRev, store.calls[0].expect.lockVersion], ['r1', 3], 'save: the page\'s head');
  assert.deepEqual([store.calls[1].expect.nativeRev, store.calls[1].expect.lockVersion], ['r2', 4], 'publish: the revision the save just created');
  assert.equal(store.calls[0].document, edited);
  assert.notEqual(store.calls[0].expect.mutationKey, store.calls[1].expect.mutationKey);
  for (const call of store.calls) assert.match(call.expect.mutationKey, /^[A-Za-z0-9._:/@+=~-]{1,128}$/);
  assert.equal(outcome.record.nativeRev, 'r3');
  assert.equal(outcome.saved.nativeRev, 'r2');
});

test('publish only: no unsaved edits means no save call', async () => {
  const store = fakeStore({ save: [rec('x', 1)], publish: [rec('r2', 1, { variant: 'published' })] });
  const outcome = await saveThenPublish(store, { id: 'welcome', expect: head, keys: new MutationKeys() });
  assert.deepEqual(store.calls.map(call => call.op), ['publish']);
  assert.deepEqual([store.calls[0].expect.nativeRev, store.calls[0].expect.lockVersion], ['r1', 3]);
  assert.equal(outcome.ok, true); assert.equal(outcome.saved, undefined);
});

test('a failed or conflicting save stops: nothing is published', async () => {
  for (const failure of [lost, { ok: false, code: 'conflict', message: 'This document changed elsewhere.' }, { ok: false, code: 'invalid', message: 'No.', fieldErrors: [{ path: ['title'], message: 'Too long' }] }, { ok: false, code: 'denied', message: 'Not allowed.' }]) {
    const store = fakeStore({ save: [failure], publish: [rec('never', 1)] });
    const outcome = await saveThenPublish(store, { id: 'welcome', expect: head, doc: edited, keys: new MutationKeys() });
    assert.deepEqual(store.calls.map(call => call.op), ['save'], failure.code);
    assert.equal(outcome.ok, false); assert.equal(outcome.stage, 'save'); assert.equal(outcome.failure.code, failure.code); assert.equal(outcome.saved, undefined);
    assert.deepEqual(outcome.failure.fieldErrors, failure.fieldErrors);
  }
  const thrown = fakeStore({ save: [lost], publish: [lost] });
  thrown.saveDraft = async () => { throw new Error('SELECT secret'); };
  const outcome = await saveThenPublish(thrown, { id: 'welcome', expect: head, doc: edited, keys: new MutationKeys() });
  assert.equal(outcome.stage, 'save'); assert.equal(outcome.failure.code, 'unavailable'); assert.ok(!JSON.stringify(outcome).includes('secret'));
});

test('a publish that fails after a good save reports the saved revision so the page can adopt it', async () => {
  const conflict = { ok: false, code: 'conflict', message: 'Changed elsewhere.' };
  const store = fakeStore({ save: [rec('r2', 4)], publish: [conflict] });
  const outcome = await saveThenPublish(store, { id: 'welcome', expect: head, doc: edited, keys: new MutationKeys() });
  assert.equal(outcome.ok, false); assert.equal(outcome.stage, 'publish'); assert.equal(outcome.failure.code, 'conflict');
  assert.equal(outcome.saved.nativeRev, 'r2');
  const flaky = await saveThenPublish(fakeStore({ save: [rec('r2', 4)], publish: [lost] }), { id: 'welcome', expect: head, doc: edited, keys: new MutationKeys() });
  assert.equal(flaky.failure.code, 'unavailable');
  assert.match(flaky.failure.message, /draft was saved, but publishing was not confirmed/, 'the generic "nothing was confirmed as saved" text would be wrong here');
  const noSave = await saveThenPublish(fakeStore({ save: [rec('x', 1)], publish: [lost] }), { id: 'welcome', expect: head, keys: new MutationKeys() });
  assert.equal(noSave.failure.message, lost.message, 'a publish-only failure keeps the store text');
});

test('retry safety: repeating after a network failure re-uses the keys of the step that failed, and a confirmed success starts fresh', async () => {
  // Save lost: the retry repeats the same save (same key), then publishes.
  const keys = new MutationKeys();
  const store = fakeStore({ save: [lost, rec('r2', 4)], publish: [rec('r3', 1, { variant: 'published' })] });
  assert.equal((await saveThenPublish(store, { id: 'welcome', expect: head, doc: edited, keys })).ok, false);
  assert.equal((await saveThenPublish(store, { id: 'welcome', expect: head, doc: edited, keys })).ok, true);
  assert.equal(store.calls[0].expect.mutationKey, store.calls[1].expect.mutationKey, 'the retried save re-uses its key');
  assert.deepEqual(store.calls.map(call => call.op), ['save', 'save', 'publish']);

  // Publish lost after a good save: the page adopts the saved revision, and the retry is a plain publish of it with the SAME publish key.
  const keys2 = new MutationKeys();
  const second = fakeStore({ save: [rec('r2', 4)], publish: [lost, rec('r3', 1, { variant: 'published' })] });
  const first = await saveThenPublish(second, { id: 'welcome', expect: head, doc: edited, keys: keys2 });
  assert.equal(first.ok, false);
  const again = await saveThenPublish(second, { id: 'welcome', expect: { nativeRev: first.saved.nativeRev, lockVersion: first.saved.lockVersion }, keys: keys2 });
  assert.equal(again.ok, true);
  assert.deepEqual(second.calls.map(call => call.op), ['save', 'publish', 'publish']);
  assert.equal(second.calls[1].expect.mutationKey, second.calls[2].expect.mutationKey, 'the retried publish re-uses its key');
  assert.deepEqual([second.calls[2].expect.nativeRev, second.calls[2].expect.lockVersion], ['r2', 4]);

  // After a confirmed outcome (the page clears the keys) the next request can never be a retry.
  keys2.clear();
  const third = fakeStore({ save: [rec('r5', 6)], publish: [rec('r6', 1, { variant: 'published' })] });
  await saveThenPublish(third, { id: 'welcome', expect: head, doc: edited, keys: keys2 });
  assert.notEqual(third.calls[1].expect.mutationKey, second.calls[1].expect.mutationKey);
  // A different edit is a different save, so it gets a different key.
  const keys3 = new MutationKeys();
  const a = fakeStore({ save: [lost], publish: [lost] }), b = fakeStore({ save: [lost], publish: [lost] });
  await saveThenPublish(a, { id: 'welcome', expect: head, doc: edited, keys: keys3 });
  await saveThenPublish(b, { id: 'welcome', expect: head, doc: doc({ title: 'Edited again' }), keys: keys3 });
  assert.notEqual(a.calls[0].expect.mutationKey, b.calls[0].expect.mutationKey);
});

test('the Studio wires Publish to the orchestration: enabled without a prior Save, no hint that edits must be saved first', () => {
  const html = connected(record());
  assert.ok(!html.includes('Save your changes before publishing') && !html.includes('Fix the blocking issues above'));
  assert.equal(stateOf(html, 'jongo-publish'), 'enabled');
});

// --- Local draft mode ---
test('local mode: Publish is visible and disabled with a visible reason, and the menu lists Duplicate and Delete as disabled with a reason', () => {
  for (const debug of [false, true]) {
    const html = local({ debug });
    assert.equal(stateOf(html, 'jongo-publish'), 'disabled', 'Publish is disabled but present');
    assert.ok(tag(html, 'jongo-publish').includes('aria-describedby="jongo-publish-reason"'));
    assert.deepEqual(reasonOf(html), { kind: 'database', text: 'Publishing needs the Jongo Craft database' });
    assert.ok(html.includes('title="Publishing needs the Jongo Craft database"'), 'also a tooltip');
    assert.equal(stateOf(html, 'jongo-save'), 'disabled', 'nothing to save yet');
    assert.ok(html.includes('Save local draft'));
    for (const id of ['jongo-duplicate', 'jongo-delete']) {
      assert.equal(stateOf(html, id), 'disabled', id);
      assert.ok(tag(html, id).includes(`aria-describedby="${id}-description"`) && tag(html, id).includes('title="Needs the Jongo Craft database"'), id);
      assert.ok(html.includes(`<span id="${id}-description" class="jongo-menu-desc">Needs the Jongo Craft database</span>`), `${id}: visible description`);
    }
    for (const id of ['jongo-reset', 'jongo-revert']) assert.equal(stateOf(html, id), 'disabled', `${id} exists (disabled until there is something to reset)`);
    assert.ok(!html.includes('Unpublish') && !html.includes('Discard draft'), 'omitted: they have no meaning without a database');
    // Names of settings stay a debug-only matter.
    assert.ok(!/JONGO_CRAFT|DATABASE_URL/.test(html.replace(/LOCAL DRAFT MODE[^<]*/, '')));
  }
  const html = local();
  // Menu order: Reset, Revert, Duplicate, Delete (separated), with the exact existing labels.
  const labels = [...html.slice(html.indexOf('id="jongo-more-menu"')).matchAll(/role="menuitem"[^>]*>(?:<svg.*?<\/svg>)?<span>([^<]*)<\/span>/g)].map(match => match[1]);
  assert.deepEqual(labels, ['Reset changes', 'Revert to original snapshot', 'Duplicate', 'Delete']);
});

test('local mode, fixed (singleton) documents: no Duplicate or Delete, plus the informational line in the header menu', () => {
  const html = local({}, { schemas: [{ ...schema, singleton: true }], documents: [doc()] });
  for (const id of ['jongo-duplicate', 'jongo-delete']) assert.equal(stateOf(html, id), 'hidden', id);
  assert.equal(stateOf(html, 'jongo-publish'), 'disabled', 'Publish itself stays visible');
  assert.ok(html.includes("Fixed page content: can&#x27;t be duplicated or deleted") || html.includes("Fixed page content: can't be duplicated or deleted"));
  assert.ok(html.includes('aria-describedby="jongo-tools-note"') && html.includes('id="jongo-tools-note"') && html.includes('data-menu-note="true"'));
  // Not interactive: it is a paragraph, not a menu item.
  assert.ok(!/<button[^>]*>[^<]*Fixed page content/.test(html));
  assert.ok(!local().includes('Fixed page content'), 'ordinary documents do not get the line');
});

test('connected singletons: still no Duplicate or Delete, and the same informational line in the header menu', () => {
  const single = { schemas: [{ ...schema, singleton: true }], documents: [] };
  const html = connected(record({ variant: 'published', published: { nativeRev: 'r1', lockVersion: 3 } }), {}, single);
  for (const id of ['jongo-duplicate', 'jongo-delete']) assert.equal(stateOf(html, id), 'hidden', id);
  assert.equal(stateOf(html, 'jongo-unpublish'), 'enabled');
  assert.ok(/data-menu-note="true"[^>]*>Fixed page content: can(?:'|&#x27;)t be duplicated or deleted</.test(html));
  const note = html.indexOf('id="jongo-tools-note"');
  assert.ok(note > html.indexOf('id="jongo-tools-menu"') && note < html.indexOf('class="jongo-editor-body"'), 'inside the header menu');
  assert.ok(!connected(record()).includes('Fixed page content'));
});

test('menu semantics keep keyboard support with disabled items: only enabled items are focus targets, disabled ones stay in the DOM', () => {
  const html = local();
  const menu = html.slice(html.indexOf('id="jongo-more-menu"'));
  assert.ok(menu.includes('role="menu"') || html.includes('id="jongo-more-menu" role="menu"'));
  const items = [...menu.matchAll(/<button[^>]*role="menuitem"[^>]*>/g)].map(match => match[0]);
  assert.equal(items.length, 4);
  assert.ok(items.every(item => item.includes('tabindex="-1"') && item.includes('disabled=""')), 'native disabled: skipped by the arrow-key query and by Tab');
  assert.ok(!items.some(item => item.includes('aria-disabled')), 'native disabled only, nothing that arrow keys could land on');
});
