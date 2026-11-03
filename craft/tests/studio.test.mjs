import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContentStudio, createContentRegistry, validateContent, CraftShell } from '../dist/index.js';
const schema = { name: 'article', title: 'Articles', type: 'document', schemaVersion: 1, fields: [
  { name: 'title', title: 'Title', type: 'string', required: true, maxLength: 20 },
  { name: 'body', title: 'Body', type: 'text', maxLength: 100 },
  { name: 'icon', title: 'Icon', type: 'enum', options: ['book', 'check'] }
] };
test('content registry rejects duplicates and invalid field descriptors', () => {
  assert.equal(createContentRegistry([schema]).get('article'), schema);
  assert.throws(() => createContentRegistry([schema, schema]));
  assert.throws(() => createContentRegistry([{ ...schema, fields: [...schema.fields, schema.fields[0]] }]));
  assert.throws(() => createContentRegistry([{ ...schema, fields: [{ name: 'x', type: 'enum' }] }]));
});
test('content validation enforces required, bounded, registered fields and enum options', () => {
  assert.deepEqual(validateContent(schema, { title: 'Hello', body: 'Copy', icon: 'book' }), {});
  assert.equal(validateContent(schema, { title: ' ' }).title, 'This field is required.');
  assert.ok(validateContent(schema, { title: 'x'.repeat(21), icon: 'bad', unregistered: 'x' }).title);
  assert.ok(validateContent(schema, { title: 'Hello', icon: 'bad', unregistered: 'x' }).icon);
  assert.ok(validateContent(schema, { title: 'Hello', unregistered: 'x' }).unregistered);
});
test('generic studio renders a non-Golf content desk with local-draft limitations only', () => {
  const html = renderToStaticMarkup(createElement(ContentStudio, { config: { schemas: [schema], documents: [{ id: 'welcome', type: 'article', title: 'Welcome', values: { title: 'Hello', body: 'Library news', icon: 'book' } }] } }));
  for (const text of ['jongo-studio', 'Structure', 'Search documents', 'Welcome', 'Save local draft', 'Reset changes', 'page memory only']) assert.ok(html.includes(text), text);
  for (const text of ['craft-root', 'GOLF LAB', 'Booking', 'PROPOSED', 'FICTIONAL DEMO', 'Chicago']) assert.ok(!html.includes(text), text);
});
test('generic shell never forces prototype banners or production security claims', () => {
  const html = renderToStaticMarkup(createElement(CraftShell, { plugin: { id: 'generic', title: 'Workspace', schemas: [], views: [] }, context: { identity: { id: 'x', label: 'Editor', role: 'editor' }, adapter: {} }, activeView: '', onNavigate() {}, brand: { name: 'Library', homeHref: '#' } }));
  for (const text of ['DEMO', 'permissions', 'Chicago', 'preview 01', 'THE GOLF LAB']) assert.ok(!html.includes(text));
});