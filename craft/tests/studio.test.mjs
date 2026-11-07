import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContentStudio, createContentRegistry, validateDocument, createReferenceIndex, CraftShell } from '../dist/index.js';
const schema = { name: 'article', title: 'Articles', type: 'document', schemaVersion: 1, fields: [
  { name: 'title', title: 'Title', type: 'string', required: true, maxLength: 20 },
  { name: 'body', title: 'Body', type: 'text', maxLength: 100 },
  { name: 'icon', title: 'Icon', type: 'enum', options: ['book', 'check'] }
] };
const article = { _id: 'welcome', _type: 'article', title: 'Hello', body: 'Library news', icon: 'book' };
test('content registry rejects duplicates and invalid field descriptors', () => {
  assert.equal(createContentRegistry([schema]).get('article'), schema);
  assert.throws(() => createContentRegistry([schema, schema]));
  assert.throws(() => createContentRegistry([{ ...schema, fields: [...schema.fields, schema.fields[0]] }]));
  assert.throws(() => createContentRegistry([{ ...schema, fields: [{ name: 'x', type: 'enum' }] }]));
  assert.throws(() => createContentRegistry([{ ...schema, fields: [{ name: 'x', type: 'asset', to: ['a'] }] }]));
  assert.throws(() => createContentRegistry([{ ...schema, fields: [{ name: 'x', type: 'array', of: [{ type: 'object', fields: [] }, { type: 'string' }] }] }]));
});
test('flat envelope validation covers required, length and enum errors at field paths', () => {
  const check = doc => validateDocument(schema, doc, createReferenceIndex([]));
  assert.deepEqual(check(article), []);
  assert.equal(check({ ...article, title: ' ' }).find(issue => issue.path[0] === 'title').code, 'required');
  assert.ok(check({ ...article, title: 'x'.repeat(21) }).some(issue => issue.path[0] === 'title' && issue.code === 'length'));
  assert.ok(check({ ...article, icon: 'bad' }).some(issue => issue.path[0] === 'icon' && issue.code === 'enum'));
  const unknown = check({ ...article, extra: 1 }).find(issue => issue.path[0] === 'extra');
  assert.equal(unknown.severity, 'warning');
});
test('generic studio renders a non-Golf content desk with local-draft limitations only', () => {
  const html = renderToStaticMarkup(createElement(ContentStudio, { config: { schemas: [schema], documents: [article] }, debug: true }));
  for (const text of ['jongo-studio', 'Structure', 'Search documents', 'Hello', 'Save local draft', 'Reset changes', 'Revert to original snapshot', 'page memory only', 'persistence and publishing are not connected', 'data-publish-ready="true"', 'role="status"', 'aria-live="polite"']) assert.ok(html.includes(text), text);
  assert.ok(!html.includes('Document checks') && !html.includes('Publish-ready checks passed'), 'a clean document shows no checks section (the header chip stays)');
  for (const text of ['craft-root', 'GOLF LAB', 'Booking', 'PROPOSED', 'FICTIONAL DEMO', 'Chicago']) assert.ok(!html.includes(text), text);
  assert.ok(html.includes('value="Hello"'));
});
test('studio shows blocking state and accessible inline errors for an invalid document without refusing to render', () => {
  const html = renderToStaticMarkup(createElement(ContentStudio, { config: { schemas: [schema], documents: [{ ...article, title: '', icon: 'bad' }] } }));
  assert.ok(html.includes('data-publish-ready="false"'));
  assert.ok(html.includes('Not publish-ready: 2 blocking issues'));
  assert.ok(html.includes('aria-invalid="true"'));
  assert.match(html, /aria-describedby="[^"]*-issues"/);
  assert.ok(html.includes('This field is required.'));
});
test('generic shell never forces prototype banners or production security claims', () => {
  const html = renderToStaticMarkup(createElement(CraftShell, { plugin: { id: 'generic', title: 'Workspace', schemas: [], views: [] }, context: { identity: { id: 'x', label: 'Editor', role: 'editor' }, adapter: {} }, activeView: '', onNavigate() {}, brand: { name: 'Library', homeHref: '#' } }));
  for (const text of ['DEMO', 'permissions', 'Chicago', 'preview 01', 'THE GOLF LAB']) assert.ok(!html.includes(text));
});