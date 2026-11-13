import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContentStudio, craftStructure as S, defaultStructure, showsDocumentList, structureTarget, structureTypes } from '../dist/index.js';

const field = [{ name: 'title', title: 'Title', type: 'string', required: true }];
const page = (name, title, singleton = true) => ({ name, title, type: 'document', schemaVersion: 1, singleton, fields: field });
const schemas = [page('hero', 'Hero'), page('about', 'About'), page('settings', 'Site settings'), page('post', 'Posts', false)];
const documents = [{ _id: 'hero-1', _type: 'hero', title: 'Welcome' }, { _id: 'about-1', _type: 'about', title: 'About us' }, { _id: 'settings-1', _type: 'settings', title: 'Settings' }, { _id: 'post-1', _type: 'post', title: 'First post' }];
const menu = S.define([
  S.group('Homepage', [S.document('hero', 'hero-1', 'Hero banner'), S.document('about', 'about-1')]),
  S.divider(),
  S.document('settings', 'settings-1', 'Site settings'),
  S.documents('post', 'News')
], schemas, { title: 'Website' });
const render = props => renderToStaticMarkup(createElement(ContentStudio, { config: { schemas, documents, structure: menu }, ...props }));

test('define rejects types that are not registered, duplicate document entries and empty groups', () => {
  assert.throws(() => S.define([S.document('nope', 'x')], schemas), /unregistered type "nope"/);
  assert.throws(() => S.define([S.documents('nope')], schemas), /unregistered/);
  assert.throws(() => S.define([S.document('hero', 'a'), S.document('hero', 'a')], schemas));
  assert.throws(() => S.define([S.group('Empty', [])], schemas));
  assert.throws(() => S.define([S.group(' ', [S.documents('post')])], schemas));
  assert.throws(() => S.define([], schemas));
  assert.doesNotThrow(() => S.define([S.document('hero', 'a'), S.document('hero', 'b')], schemas), 'two different documents of one type are fine');
});

test('the menu opens its first entry, knows every type it reaches and offers a list only where it lists', () => {
  assert.deepEqual(structureTarget(menu), { type: 'hero', id: 'hero-1' });
  assert.deepEqual(structureTarget(S.define([S.documents('post')], schemas)), { type: 'post' });
  assert.equal(structureTarget(undefined), undefined);
  assert.deepEqual([...structureTypes(menu)].sort(), ['about', 'hero', 'post', 'settings']);
  assert.equal(showsDocumentList(menu, 'hero', 'hero-1'), false);
  assert.equal(showsDocumentList(menu, 'post', 'post-1'), true);
  assert.equal(showsDocumentList(menu, 'post'), true);
  assert.equal(showsDocumentList(undefined, 'hero', 'hero-1'), true);
  assert.deepEqual(defaultStructure(schemas).items.map(item => item.type), ['hero', 'about', 'settings', 'post']);
});

test('the studio renders the grouped menu, marks the open entry and hides the list beside a fixed document', () => {
  const html = render({});
  assert.match(html, /<h2>Website<\/h2>/);
  assert.match(html, /role="group" aria-label="Homepage"/);
  assert.match(html, /Hero banner/);
  assert.match(html, /About<span>/, 'an entry without a title uses the type title');
  assert.match(html, /<hr class="jongo-nav-divider"/);
  assert.match(html, /href="[^"]*#jongo-editor"[^>]*aria-current="page"[^>]*>Hero banner/, 'the first entry is open without an address');
  assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
  assert.ok(html.includes('data-list="false"') && !html.includes('aria-label="Document list"'), 'no list pane beside a fixed document');
  assert.ok(html.includes('value="Welcome"'));
});

test('a list entry shows its list pane and a fixed document entry shows its own document', () => {
  const posts = render({ initialType: 'post' });
  assert.ok(posts.includes('aria-label="Document list"') && !posts.includes('data-list="false"') && posts.includes('First post'));
  assert.match(posts, /aria-current="page"[^>]*>News/);
  const settings = render({ initialType: 'settings', initialDocument: 'settings-1' });
  assert.match(settings, /aria-current="page"[^>]*>Site settings/);
  assert.ok(settings.includes('value="Settings"'));
});

test('without a structure the menu is one list per type, as before', () => {
  const html = renderToStaticMarkup(createElement(ContentStudio, { config: { schemas, documents } }));
  assert.match(html, /<h2>Content<\/h2>/);
  assert.ok(!html.includes('jongo-nav-group') && !html.includes('data-list="false"'));
  for (const title of ['Hero', 'About', 'Site settings', 'Posts']) assert.ok(html.includes(`>${title}<span>`), title);
  assert.ok(html.includes('aria-label="Document list"'));
});
