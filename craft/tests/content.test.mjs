import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ContentStudio, appendItem, canAddItem, createContentRegistry, createReferenceIndex, deepEqual, documentTitle, ensureKeys, isSafeUrl, logicalId,
  memberFor, moveItem, newImage, newItem, newReference, publishState, removeItem, replaceItem, resolveReference, searchReferences, setField, slugify, validateDocument
} from '../dist/index.js';

const schema = { name: 'page', title: 'Pages', type: 'document', schemaVersion: 1, preview: { title: 'title' }, fields: [
  { name: 'title', title: 'Title', type: 'string', required: true, minLength: 3, maxLength: 20 },
  { name: 'views', type: 'number', integer: true, min: 0, max: 10 },
  { name: 'live', type: 'boolean' },
  { name: 'on', type: 'date' }, { name: 'at', type: 'datetime' },
  { name: 'link', type: 'url' },
  { name: 'slug', type: 'slug', required: true, source: 'title' },
  { name: 'kind', type: 'enum', options: ['a', 'b'] },
  { name: 'steps', type: 'array', minItems: 1, maxItems: 3, of: [{ type: 'object', fields: [{ name: 'label', type: 'string', required: true }, { name: 'icon', type: 'enum', options: ['x'] }] }] },
  { name: 'tags', type: 'array', of: [{ type: 'string', maxLength: 5 }] },
  { name: 'author', type: 'reference', to: ['person'], required: true },
  { name: 'related', type: 'array', maxItems: 2, of: [{ type: 'reference', to: ['person'], weak: true }] },
  { name: 'hero', type: 'image', altRequired: true },
  { name: 'body', type: 'portableText', required: true }
] };
const people = [{ _id: 'p1', _type: 'person', name: 'Ada' }, { _id: 'drafts.p2', _type: 'person', name: 'Grace' }, { _id: 'x1', _type: 'article' }];
const assets = [{ _id: 'image-a', _type: 'sanity.imageAsset', url: '/a.png', originalFilename: 'a.png' }];
const index = createReferenceIndex(people, assets);
const para = text => ({ _type: 'block', _key: 'b1', style: 'normal', markDefs: [], children: [{ _type: 'span', _key: 's1', text, marks: [] }] });
const good = () => ({ _id: 'home', _type: 'page', title: 'Home page', slug: { _type: 'slug', current: 'home' }, steps: [{ _key: 'a', label: 'One' }],
  author: { _type: 'reference', _ref: 'p1' }, hero: { _type: 'image', asset: { _type: 'reference', _ref: 'image-a' }, alt: 'A' }, body: [para('Hi')] });
const issues = doc => validateDocument(schema, doc, index);
const find = (list, ...path) => list.filter(issue => issue.path.join('.') === path.join('.'));

test('a fully valid Sanity-shaped document has no issues and is publish-ready', () => {
  assert.deepEqual(issues(good()), []);
  assert.deepEqual(publishState(issues(good())), { ready: true, errors: 0, warnings: 0 });
});
test('envelope fields are checked at the top level without a values wrapper', () => {
  assert.ok(find(issues({ ...good(), _id: '' }), '_id').length);
  assert.ok(find(issues({ ...good(), _type: 'other' }), '_type').length);
});
test('string, number, url, date and enum rules report the right field path', () => {
  assert.equal(find(issues({ ...good(), title: '' }), 'title')[0].code, 'required');
  assert.ok(find(issues({ ...good(), title: 'ab' }), 'title')[0].message.includes('at least 3'));
  assert.ok(find(issues({ ...good(), title: 'x'.repeat(21) }), 'title')[0].message.includes('at most 20'));
  assert.ok(find(issues({ ...good(), views: 11 }), 'views').length);
  assert.ok(find(issues({ ...good(), views: -1 }), 'views').length);
  assert.ok(find(issues({ ...good(), views: 1.5 }), 'views').length);
  assert.ok(find(issues({ ...good(), views: '3' }), 'views').length);
  assert.equal(find(issues({ ...good(), views: 0, live: false }), 'views').length, 0);
  assert.ok(find(issues({ ...good(), link: 'javascript:alert(1)' }), 'link').length);
  assert.equal(find(issues({ ...good(), link: '/relative' }), 'link').length, 0);
  assert.ok(find(issues({ ...good(), on: '2026-02-30' }), 'on').length);
  assert.equal(find(issues({ ...good(), on: '2028-02-29' }), 'on').length, 0);
  assert.ok(find(issues({ ...good(), at: '2026-01-01' }), 'at').length);
  assert.equal(find(issues({ ...good(), at: '2026-01-01T10:30:00.000Z' }), 'at').length, 0);
  assert.ok(find(issues({ ...good(), kind: 'c' }), 'kind').length);
  assert.equal(find(issues({ ...good(), kind: 'a' }), 'kind').length, 0);
  assert.ok(find(issues({ ...good(), live: 'yes' }), 'live').length);
});
test('slug format and presence', () => {
  for (const current of ['Has Space', 'UPPER', '-lead', 'double--hyphen', 'trail-', 'x'.repeat(97)]) assert.ok(find(issues({ ...good(), slug: { _type: 'slug', current } }), 'slug').length, current);
  assert.equal(find(issues({ ...good(), slug: { _type: 'slug', current: 'ok-slug-2' } }), 'slug').length, 0);
  assert.equal(find(issues({ ...good(), slug: { _type: 'slug', current: '' } }), 'slug')[0].code, 'required');
  assert.ok(find(issues({ ...good(), slug: 'home' }), 'slug').length);
  assert.equal(slugify('  Héllo, Wörld! 2026 '), 'hello-world-2026');
});
test('array min/max, nested object paths, primitive members and unique stable keys', () => {
  assert.ok(find(issues({ ...good(), steps: [] }), 'steps')[0].message.includes('at least 1'));
  assert.ok(find(issues({ ...good(), steps: ['a', 'b', 'c', 'd'].map(label => ({ _key: label, label })) }), 'steps')[0].message.includes('at most 3'));
  assert.equal(find(issues({ ...good(), steps: [{ _key: 'a', label: '' }] }), 'steps', 0, 'label')[0].code, 'required');
  assert.ok(find(issues({ ...good(), steps: [{ _key: 'a', label: 'x', icon: 'bad' }] }), 'steps', 0, 'icon').length);
  assert.ok(find(issues({ ...good(), steps: [{ _key: 'a', label: 'x' }, { _key: 'a', label: 'y' }] }), 'steps', 1)[0].code === 'duplicate_key');
  assert.ok(find(issues({ ...good(), steps: [{ label: 'x' }] }), 'steps', 0)[0].code === 'key');
  assert.ok(find(issues({ ...good(), tags: ['ok', 'too long'] }), 'tags', 1).length);
  assert.ok(find(issues({ ...good(), tags: [''] }), 'tags', 0).length);
  assert.equal(find(issues({ ...good(), tags: ['fine'] }), 'tags').length, 0);
  assert.ok(find(issues({ ...good(), steps: [{ _key: 'a', label: 'x' }, 7] }), 'steps', 1).some(issue => issue.code === 'type'));
});
test('references must exist, avoid the drafts. prefix and match allowed types; weak references may dangle', () => {
  const ref = _ref => ({ _type: 'reference', _ref });
  assert.equal(find(issues({ ...good(), author: ref('p2') }), 'author').length, 0);
  assert.ok(find(issues({ ...good(), author: ref('drafts.p2') }), 'author')[0].message.includes('drafts.'));
  assert.equal(find(issues({ ...good(), author: ref('nope') }), 'author')[0].message, 'The referenced document was not found.');
  assert.equal(find(issues({ ...good(), author: ref('x1') }), 'author')[0].code, 'reference_type');
  const { author, ...noAuthor } = good();
  assert.equal(find(issues(noAuthor), 'author')[0].code, 'required');
  assert.equal(find(issues({ ...good(), related: [{ _key: 'r', ...ref('nope') }] }), 'related', 0)[0].severity, 'warning');
  assert.equal(find(issues({ ...good(), related: [{ _key: 'r', ...ref('p1') }, { _key: 'q', ...ref('p2') }, { _key: 't', ...ref('p1') }] }), 'related')[0].code, 'array_bounds');
});
test('reference resolution prefers draft variants, searches by title and respects allowed types', () => {
  assert.equal(logicalId('drafts.p2'), 'p2');
  assert.equal(resolveReference(index, { _ref: 'p2' }, ['person']).entry._id, 'drafts.p2');
  assert.equal(resolveReference(index, { _ref: 'p1' }, ['article']).status, 'type');
  assert.equal(resolveReference(index, undefined, ['person']).status, 'empty');
  assert.equal(resolveReference(index, { _ref: 'drafts.p1' }, ['person']).status, 'draftPrefix');
  const registry = createContentRegistry([{ name: 'person', type: 'document', schemaVersion: 1, preview: { title: 'name' }, fields: [{ name: 'name', type: 'string' }] }]);
  assert.deepEqual(searchReferences(index, ['person'], '', registry).map(item => [item.id, item.title]), [['p1', 'Ada'], ['p2', 'Grace']]);
  assert.deepEqual(searchReferences(index, ['person'], 'grac', registry).map(item => item.id), ['p2']);
  assert.deepEqual(searchReferences(index, ['person'], 'p1', registry).map(item => item.id), ['p1']);
  assert.deepEqual(searchReferences(index, ['sanity.imageAsset'], '', registry).map(item => item.title), ['a.png']);
  assert.deepEqual(newReference('drafts.p2', true, 'k'), { _type: 'reference', _key: 'k', _ref: 'p2', _weak: true });
  assert.deepEqual(newImage('image-a', 'k'), { _type: 'image', _key: 'k', asset: { _type: 'reference', _ref: 'image-a' } });
  assert.equal(documentTitle({ _id: 'drafts.q' }), 'q');
});
test('images need an existing image asset and optionally alt text', () => {
  const image = asset => ({ _type: 'image', asset: { _type: 'reference', _ref: asset }, alt: 'x' });
  assert.equal(find(issues({ ...good(), hero: image('p1') }), 'hero', 'asset')[0].code, 'reference_type');
  assert.equal(find(issues({ ...good(), hero: image('missing') }), 'hero', 'asset')[0].code, 'reference');
  assert.equal(find(issues({ ...good(), hero: { ...image('image-a'), alt: ' ' } }), 'hero', 'alt')[0].code, 'alt');
  assert.equal(find(issues({ ...good(), hero: { _type: 'image', alt: 'x' } }), 'hero').length, 0);
});
test('portable text validation flags broken data but only warns about preserved unknowns', () => {
  const bad = key => ({ ...good(), body: [{ ...para('x'), ...key }] });
  assert.equal(find(issues({ ...good(), body: [] }), 'body')[0].code, 'required');
  assert.equal(find(issues({ ...good(), body: [para(' ')] }), 'body')[0].code, 'required');
  assert.ok(find(issues({ ...good(), body: [para('a'), para('b')] }), 'body', 1)[0].code === 'duplicate_key');
  assert.ok(find(issues(bad({ markDefs: [{ _key: 'l', _type: 'link', href: 'javascript:x' }] })), 'body', 0, 'markDefs', 0, 'href').length);
  assert.ok(find(issues(bad({ listItem: 'bullet', level: 11 })), 'body', 0, 'level').length);
  const warnings = issues({ ...good(), body: [{ ...para('x'), style: 'h1', markDefs: [{ _key: 'c', _type: 'comment' }], children: [{ _type: 'span', _key: 's', text: 'x', marks: ['c', 'ghost'] }] }, { _type: 'table', _key: 't' }] });
  assert.deepEqual(warnings.map(issue => issue.severity), ['warning', 'warning', 'warning', 'warning']);
  assert.ok(publishState(warnings).ready);
});
test('publishRequired and private flags do not stop drafts but block publish-ready', () => {
  const custom = { ...schema, fields: [{ name: 'title', type: 'string', publishRequired: true, private: true }] };
  const result = validateDocument(custom, { _id: 'a', _type: 'page' }, index);
  assert.deepEqual(result.map(issue => issue.code), ['publish_required']);
  assert.equal(publishState(result).ready, false);
});
test('array operations are immutable, bounded and shape-aware', () => {
  const list = ['a', 'b', 'c'];
  assert.deepEqual(moveItem(list, 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(moveItem(list, 2, 1), ['a', 'c', 'b']);
  assert.deepEqual(moveItem(list, 0, 9), list);
  assert.deepEqual(removeItem(list, 1), ['a', 'c']);
  assert.deepEqual(appendItem(undefined, 'x'), ['x']);
  assert.deepEqual(replaceItem(list, 1, 'z'), ['a', 'z', 'c']);
  assert.deepEqual(list, ['a', 'b', 'c']);
  const array = { type: 'array', maxItems: 2, of: [{ type: 'object', objectType: 'step', fields: [] }, { type: 'string' }] };
  assert.equal(canAddItem(array, 1), true); assert.equal(canAddItem(array, 2), false);
  assert.equal(memberFor(array, { _type: 'step' }).type, 'object');
  assert.equal(memberFor(array, 'text').type, 'string');
  assert.equal(memberFor(array, 4), undefined);
  assert.deepEqual(newItem(array.of[0], () => 'k'), { _type: 'step', _key: 'k' });
  assert.equal(newItem(array.of[1]), '');
  assert.deepEqual(setField({ a: 1, b: 2 }, 'b', undefined), { a: 1 });
  assert.ok(deepEqual({ a: [1, { b: 2 }], c: undefined }, { a: [1, { b: 2 }] }));
  assert.ok(!deepEqual({ a: [1] }, { a: [2] }));
});
test('ensureKeys adds deterministic keys to arrays and portable text without touching existing keys', () => {
  const doc = { _id: 'home', _type: 'page', steps: [{ label: 'a' }, { _key: 'keep', label: 'b' }], tags: ['x'], body: [{ _type: 'block', children: [{ _type: 'span', text: 'x', marks: [] }], markDefs: [] }] };
  const keyed = ensureKeys(schema, doc);
  assert.deepEqual(keyed.steps.map(step => step._key), ['k1', 'keep']);
  assert.deepEqual(keyed.tags, ['x']);
  assert.equal(keyed.body[0]._key, 'b1');
  assert.deepEqual(ensureKeys(schema, keyed), keyed);
  assert.deepEqual(ensureKeys(schema, ensureKeys(schema, doc)), keyed);
});
test('url helper accepts navigation URLs only', () => {
  for (const url of ['https://a.example', 'http://a.example/x', 'mailto:a@b.example', 'tel:+1555', '/path', '#frag']) assert.ok(isSafeUrl(url), url);
  for (const url of ['', 'javascript:alert(1)', 'data:text/html,x', '//evil.example', 'not a url', 'https://a b']) assert.ok(!isSafeUrl(url), url);
});

const config = () => ({ schemas: [schema, { name: 'person', title: 'People', type: 'document', schemaVersion: 1, preview: { title: 'name' }, fields: [{ name: 'name', type: 'string' }] }],
  documents: [{ ...good(), related: [{ _type: 'reference', _key: 'r1', _ref: 'p1' }], tags: ['one'], body: [para('Hello world'), { _type: 'table', _key: 'tb', rows: [['x']] },
    { ...para('Odd'), _key: 'b3', style: 'h1', children: [{ _type: 'span', _key: 'sx', text: 'Odd', marks: ['strong', 'ghost'] }] }] }, { _id: 'p1', _type: 'person', name: 'Ada' }], assets });
test('SSR renders each field type with labels, groups, controls and preserved blocks', () => {
  const html = renderToStaticMarkup(createElement(ContentStudio, { config: config() }));
  for (const text of ['<fieldset', '<legend>', 'for="jongo-home-title"', 'id="jongo-home-title"', 'type="number"', 'type="checkbox"', 'type="date"', 'type="datetime-local"', 'Generate from title', 'Choose an option</option>',
    'Add Item', 'Add Reference', 'Move Item 1 down', 'Remove Item 1', 'Ada', 'Allowed types: person', 'Change hero', 'a.png', 'Alternative text',
    'Block 1 · Normal', 'Text of block 1', 'Bold for selected text in block 1', 'aria-pressed="false"', 'Add link to selected text in block 1', 'Formatted preview', 'Add paragraph',
    'Preserved block (table)', 'View preserved JSON', 'data-preserved-marks="ghost"', 'h1 (preserved)', '3 notes about preserved content', 'Document checks']) assert.ok(html.includes(text), text);
  assert.ok(!html.includes('contenteditable'));
});
test('SSR marks every invalid control with aria-invalid and an aria-describedby error list, and lists a summary', () => {
  const doc = { ...good(), title: '', views: 99, link: 'nope', steps: [{ _key: 'a', label: '' }], hero: { _type: 'image', asset: { _type: 'reference', _ref: 'image-a' } }, tags: ['toolong'] };
  const html = renderToStaticMarkup(createElement(ContentStudio, { config: { ...config(), documents: [doc] } }));
  for (const id of ['jongo-home-title', 'jongo-home-views', 'jongo-home-link', 'jongo-home-steps.0.label', 'jongo-home-tags.0']) {
    const tag = html.match(new RegExp(`<(?:input|textarea|select)[^>]*id="${id}"[^>]*>`))?.[0] ?? '';
    assert.ok(tag.includes('aria-invalid="true"'), id);
    assert.ok(tag.includes(`aria-describedby="${id}-issues"`) || tag.includes(`${id}-issues`), id);
    assert.ok(html.includes(`id="${id}-issues"`), id);
  }
  assert.ok(html.includes('data-publish-ready="false"'));
  assert.ok(html.includes('Add alternative text for this image.'));
});
