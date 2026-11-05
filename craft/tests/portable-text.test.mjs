import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLink, blockText, createTextBlock, diffText, ensurePortableTextKeys, hasPortableTextContent, isEditableTextBlock, listLinks, moveNode,
  normalizeBlock, rangeHasMark, removeLink, replaceRange, segments, setBlockList, setBlockStyle, setBlockText, toggleDecorator, uniqueKeys, updateLinkHref
} from '../dist/portable-text.js';

const counter = () => { let n = 0; return () => `k${++n}`; };
const block = (text, extra = {}) => ({ _type: 'block', _key: 'b1', style: 'normal', markDefs: [], children: [{ _type: 'span', _key: 's1', text, marks: [] }], ...extra });
const view = b => b.children.map(span => [span.text, span.marks]);

test('toggling a decorator splits spans, keeps the first key and merges back when removed', () => {
  const bold = toggleDecorator(block('Hello world'), { start: 0, end: 5 }, 'strong', counter());
  assert.deepEqual(view(bold), [['Hello', ['strong']], [' world', []]]);
  assert.equal(bold.children[0]._key, 's1');
  assert.ok(rangeHasMark(bold, { start: 0, end: 5 }, 'strong'));
  assert.ok(!rangeHasMark(bold, { start: 0, end: 8 }, 'strong'));
  const plain = toggleDecorator(bold, { start: 0, end: 5 }, 'strong', counter());
  assert.deepEqual(view(plain), [['Hello world', []]]);
  assert.equal(plain.children[0]._key, 's1');
});
test('partial overlap extends the mark and adjacent identical spans are normalized', () => {
  const mk = counter();
  const bold = toggleDecorator(block('Hello world'), { start: 0, end: 5 }, 'strong', mk);
  const wider = toggleDecorator(bold, { start: 3, end: 8 }, 'strong', mk);
  assert.deepEqual(view(wider), [['Hello wo', ['strong']], ['rld', []]]);
  assert.equal(wider.children[0]._key, 's1');
  assert.deepEqual(toggleDecorator(block('abc'), { start: 1, end: 1 }, 'strong'), block('abc'));
  assert.deepEqual(toggleDecorator(block('abc'), { start: 0, end: 3 }, 'underline'), block('abc'));
});
test('normalizeBlock merges equal mark sets in any order, drops empties, dedupes and is idempotent', () => {
  const messy = block('', { children: [
    { _type: 'span', _key: 'a', text: 'A', marks: ['strong', 'em'] }, { _type: 'span', _key: 'b', text: 'B', marks: ['em', 'strong', 'em'] },
    { _type: 'span', _key: 'c', text: '', marks: [] }, { _type: 'span', _key: 'd', text: 'C', marks: [] }, { _type: 'span', _key: 'e', text: 'D' }
  ] });
  const once = normalizeBlock(messy);
  assert.deepEqual(view(once), [['AB', ['strong', 'em']], ['CD', []]]);
  assert.deepEqual(once.children.map(span => span._key), ['a', 'd']);
  assert.deepEqual(normalizeBlock(once), once);
  const empty = normalizeBlock(block('', { children: [{ _type: 'span', _key: 'only', text: '', marks: ['strong'] }] }));
  assert.deepEqual(empty.children, [{ _type: 'span', _key: 'only', text: '', marks: [] }]);
  assert.deepEqual(normalizeBlock({ ...block('x'), markDefs: undefined }).markDefs, []);
});
test('typing inherits neighbouring marks without creating spans, so keys stay stable', () => {
  const bold = toggleDecorator(block('Hello world'), { start: 0, end: 5 }, 'strong', counter());
  const typed = setBlockText(bold, 'Hellooo world', 7, counter());
  assert.deepEqual(view(typed), [['Hellooo', ['strong']], [' world', []]]);
  assert.deepEqual(typed.children.map(span => span._key), ['s1', 'k1']);
  const front = setBlockText(bold, 'XHello world', 1, counter());
  assert.deepEqual(view(front), [['XHello', ['strong']], [' world', []]]);
  const deleted = replaceRange(bold, 3, 8, '', counter());
  assert.deepEqual(view(deleted), [['Hel', ['strong']], ['rld', []]]);
  const replaced = replaceRange(block('abc', { children: [{ _type: 'span', _key: 's1', text: 'abc', marks: ['em'] }] }), 0, 3, 'xyz', counter());
  assert.deepEqual(view(replaced), [['xyz', ['em']]]);
  assert.deepEqual(view(replaceRange(block('abc'), 0, 3, '', counter())), [['', []]]);
  assert.equal(blockText(setBlockText(block('abc'), '', undefined, counter())), '');
  const same = block('abc');
  assert.equal(setBlockText(same, 'abc'), same);
});
test('diffText finds the changed region and uses the caret for ambiguous insertions', () => {
  assert.deepEqual(diffText('abc', 'abXc'), { start: 2, end: 2, insert: 'X' });
  assert.deepEqual(diffText('abcd', 'ad'), { start: 1, end: 3, insert: '' });
  assert.deepEqual(diffText('aa', 'aaa', 1), { start: 0, end: 0, insert: 'a' });
  assert.deepEqual(diffText('aa', 'aaa'), { start: 2, end: 2, insert: 'a' });
  assert.deepEqual(diffText('same', 'same'), { start: 4, end: 4, insert: '' });
});
test('link annotations use stable keys, replace overlapping links and only prune links they removed', () => {
  const mk = counter();
  const withComment = block('Visit our site now', { markDefs: [{ _key: 'c1', _type: 'comment', author: 'a' }], children: [{ _type: 'span', _key: 's1', text: 'Visit our site now', marks: ['c1'] }] });
  const linked = applyLink(withComment, { start: 6, end: 9 }, 'https://example.com/a', mk);
  assert.equal(listLinks(linked).length, 1);
  assert.deepEqual([listLinks(linked)[0].href, listLinks(linked)[0].text], ['https://example.com/a', 'our']);
  assert.deepEqual(view(linked).map(([text]) => text), ['Visit ', 'our', ' site now']);
  assert.ok(linked.children.every(span => span.marks.includes('c1')));
  const [{ key }] = listLinks(linked);
  assert.deepEqual(segments(linked).map(part => part.href), [undefined, 'https://example.com/a', undefined]);
  const edited = updateLinkHref(linked, key, 'https://example.com/b');
  assert.equal(listLinks(edited)[0].href, 'https://example.com/b');
  const relinked = applyLink(edited, { start: 6, end: 9 }, 'https://example.org', mk);
  assert.equal(listLinks(relinked).length, 1);
  assert.equal(listLinks(relinked)[0].href, 'https://example.org');
  const removed = removeLink(relinked, listLinks(relinked)[0].key);
  assert.deepEqual(removed.markDefs, [{ _key: 'c1', _type: 'comment', author: 'a' }]);
  assert.deepEqual(view(removed), [['Visit our site now', ['c1']]]);
  assert.equal(removed.children[0]._key, 's1');
  assert.equal(removeLink(withComment, 'c1'), withComment);
  assert.equal(applyLink(withComment, { start: 2, end: 2 }, 'https://x.example', mk), withComment);
});
test('unknown styles, list types, marks, annotations and extra fields survive every text operation', () => {
  const odd = { _type: 'block', _key: 'b2', style: 'h1', listItem: 'checklist', level: 2, customField: { nested: [1, 2] }, markDefs: [{ _key: 'c1', _type: 'comment', author: 'a' }],
    children: [{ _type: 'span', _key: 's1', text: 'Note text', marks: ['c1', 'mystery'] }] };
  assert.ok(isEditableTextBlock(odd));
  const typed = setBlockText(odd, 'Note texts', 10, counter());
  assert.deepEqual(typed, { ...odd, children: [{ _type: 'span', _key: 's1', text: 'Note texts', marks: ['c1', 'mystery'] }] });
  const bold = toggleDecorator(odd, { start: 0, end: 4 }, 'strong', counter());
  assert.deepEqual(bold.children.map(span => span.marks), [['c1', 'mystery', 'strong'], ['c1', 'mystery']]);
  for (const key of ['style', 'listItem', 'level', 'customField', 'markDefs']) assert.deepEqual(bold[key], odd[key]);
  const restyled = setBlockStyle(odd, 'h2');
  assert.deepEqual({ ...restyled, style: 'h1' }, odd);
  assert.equal(segments(odd)[0].unknown.join(), 'c1,mystery');
});
test('blocks with inline objects, rich spans or foreign node types are not editable and are never rewritten', () => {
  const inline = { _type: 'block', _key: 'b', markDefs: [], children: [{ _type: 'span', _key: 's', text: 'a', marks: [] }, { _type: 'inlineWidget', _key: 'w', id: 7 }] };
  const richSpan = { _type: 'block', _key: 'b', markDefs: [], children: [{ _type: 'span', _key: 's', text: 'a', marks: [], comment: 'x' }] };
  for (const node of [inline, richSpan, { _type: 'image', _key: 'i', asset: { _type: 'reference', _ref: 'img' } }, { _type: 'table', _key: 't', rows: [] }, null, 'text']) assert.equal(isEditableTextBlock(node), false);
  const nodes = [block('one'), { _type: 'table', _key: 't', rows: [[1]] }, inline];
  const reordered = moveNode(nodes, 0, 2);
  assert.equal(reordered[0], nodes[1]); assert.equal(reordered[1], nodes[2]); assert.equal(reordered[2], nodes[0]);
  assert.equal(ensurePortableTextKeys(nodes), nodes);
});
test('block style, list and creation helpers produce valid Portable Text and keep unrelated keys', () => {
  const created = createTextBlock(counter(), 'h2');
  assert.deepEqual(created, { _type: 'block', _key: 'k1', style: 'h2', markDefs: [], children: [{ _type: 'span', _key: 'k2', text: '', marks: [] }] });
  const listed = setBlockList(block('x'), 'bullet');
  assert.deepEqual([listed.listItem, listed.level], ['bullet', 1]);
  assert.equal(setBlockList(listed, 'bullet', 3).level, 3);
  assert.equal(setBlockList(listed, 'bullet', 99).level, 10);
  const plain = setBlockList(listed, null);
  assert.ok(!('listItem' in plain) && !('level' in plain));
  assert.equal(hasPortableTextContent([created]), false);
  assert.equal(hasPortableTextContent([block('hi')]), true);
  assert.equal(hasPortableTextContent([{ _type: 'image', _key: 'i' }]), true);
});
test('keys: missing and duplicate keys are filled deterministically and existing keys are never rewritten', () => {
  const items = [{ _key: 'a' }, { x: 1 }, { _key: 'a' }, { _key: 'k1' }, 'plain'];
  const keyed = uniqueKeys(items, 'k');
  assert.equal(keyed[0], items[0]); assert.equal(keyed[3], items[3]);
  assert.deepEqual(keyed.map(item => item?._key), ['a', 'k2', 'k3', 'k1', undefined]);
  assert.deepEqual(uniqueKeys(items, 'k'), keyed);
  const messy = [{ _type: 'block', children: [{ _type: 'span', text: 'a', marks: [] }, { _type: 'span', text: 'b', marks: [] }], markDefs: [{ _type: 'link', href: '/' }] }];
  const fixed = ensurePortableTextKeys(messy);
  assert.deepEqual([fixed[0]._key, fixed[0].children.map(span => span._key), fixed[0].markDefs[0]._key], ['b1', ['s1', 's2'], 'm1']);
  assert.deepEqual(ensurePortableTextKeys(fixed), fixed);
  assert.equal(ensurePortableTextKeys(undefined), undefined);
});
