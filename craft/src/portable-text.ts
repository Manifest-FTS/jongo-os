/** Pure Portable Text operations. No React, DOM or network. Every function returns new values and
 * never drops unknown block types, marks, annotations or extra fields: only the block being edited is
 * rebuilt, and unrecognised content inside it is carried across untouched. */
export type JsonObject = { [key: string]: unknown };
export type Span = { _type: 'span'; _key: string; text: string; marks?: string[] } & JsonObject;
export type TextBlock = { _type: 'block'; _key: string; children: Span[]; markDefs?: JsonObject[]; style?: string; listItem?: string; level?: number } & JsonObject;
export type PortableTextNode = JsonObject;
export type KeyMaker = () => string;
export type Selection = { start: number; end: number };

export const STYLES = ['normal', 'h2', 'h3', 'h4', 'blockquote'] as const;
export const DECORATORS = ['strong', 'em', 'code'] as const;
export const LIST_ITEMS = ['bullet', 'number'] as const;
export const MAX_LIST_LEVEL = 10;

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
export function randomKey(): string {
  const bytes = new Uint8Array(6);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

const SPAN_KEYS = ['_type', '_key', 'text', 'marks'];
export function isPlainSpan(value: unknown): value is Span {
  return isObject(value) && value._type === 'span' && typeof value.text === 'string'
    && (value.marks === undefined || (Array.isArray(value.marks) && value.marks.every(mark => typeof mark === 'string')))
    && Object.keys(value).every(key => SPAN_KEYS.includes(key));
}
/** Only blocks whose every child is a plain span are text-editable. Others are shown as preserved blocks. */
export function isEditableTextBlock(value: unknown): value is TextBlock {
  return isObject(value) && value._type === 'block' && Array.isArray(value.children) && value.children.every(isPlainSpan)
    && (value.markDefs === undefined || (Array.isArray(value.markDefs) && value.markDefs.every(isObject)));
}
const marksOf = (span: Span) => span.marks ?? [];
export const blockText = (block: TextBlock) => block.children.map(span => span.text).join('');
const defs = (block: TextBlock) => block.markDefs ?? [];
export const isLinkMark = (block: TextBlock, mark: string) => defs(block).some(def => def._key === mark && def._type === 'link');
export const isDecorator = (mark: string) => (DECORATORS as readonly string[]).includes(mark);

export function createTextBlock(makeKey: KeyMaker = randomKey, style = 'normal'): TextBlock {
  return { _type: 'block', _key: makeKey(), style, markDefs: [], children: [{ _type: 'span', _key: makeKey(), text: '', marks: [] }] };
}

/** Merge adjacent spans that carry the same mark set; the earlier span keeps its key. Idempotent. */
export function normalizeBlock(block: TextBlock): TextBlock {
  const out: Span[] = [];
  for (const span of block.children) {
    if (span.text === '') continue;
    const marks = Array.from(new Set(marksOf(span)));
    const last = out.at(-1);
    if (last && sameMarks(marksOf(last), marks)) out[out.length - 1] = { ...last, text: last.text + span.text };
    else out.push({ ...span, marks });
  }
  if (!out.length) { const first = block.children[0]; out.push({ _type: 'span', _key: first?._key ?? randomKey(), text: '', marks: [] }); }
  return { ...block, markDefs: block.markDefs ?? [], children: out };
}
function sameMarks(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every(mark => b.includes(mark));
}

function splitSpansAt(children: Span[], offset: number, makeKey: KeyMaker): Span[] {
  const out: Span[] = [];
  let position = 0;
  for (const span of children) {
    const end = position + span.text.length;
    if (offset > position && offset < end) {
      const cut = offset - position;
      out.push({ ...span, text: span.text.slice(0, cut) }, { ...span, _key: makeKey(), text: span.text.slice(cut) });
    } else out.push(span);
    position = end;
  }
  return out;
}
/** Index and extent of each span, so callers can reason about aligned ranges. */
function layout(children: Span[]) {
  let position = 0;
  return children.map(span => { const start = position; position += span.text.length; return { span, start, end: position }; });
}
const clamp = (block: TextBlock, selection: Selection): Selection => {
  const length = blockText(block).length;
  const start = Math.max(0, Math.min(selection.start, selection.end, length)), end = Math.max(0, Math.min(Math.max(selection.start, selection.end), length));
  return { start, end };
};
function mapRange(block: TextBlock, selection: Selection, makeKey: KeyMaker, change: (span: Span, hit: boolean) => Span): TextBlock {
  const { start, end } = clamp(block, selection);
  let children = splitSpansAt(block.children, start, makeKey);
  children = splitSpansAt(children, end, makeKey);
  const next = layout(children).map(({ span, start: from, end: to }) => change(span, to > from && from >= start && to <= end));
  return normalizeBlock({ ...block, children: next });
}
function rangeSpans(block: TextBlock, selection: Selection) {
  const { start, end } = clamp(block, selection);
  return layout(block.children).filter(item => item.end > item.start && item.end > start && item.start < end);
}

export function rangeHasMark(block: TextBlock, selection: Selection, mark: string): boolean {
  const spans = rangeSpans(block, selection);
  return clamp(block, selection).start !== clamp(block, selection).end && spans.length > 0 && spans.every(item => marksOf(item.span).includes(mark));
}
/** Add the decorator to the whole selection, or remove it when the whole selection already has it. */
export function toggleDecorator(block: TextBlock, selection: Selection, decorator: string, makeKey: KeyMaker = randomKey): TextBlock {
  const range = clamp(block, selection);
  if (range.start === range.end || !isDecorator(decorator)) return block;
  const remove = rangeHasMark(block, range, decorator);
  return mapRange(block, range, makeKey, (span, hit) => !hit ? span
    : { ...span, marks: remove ? marksOf(span).filter(mark => mark !== decorator) : [...marksOf(span).filter(mark => mark !== decorator), decorator] });
}

function pruneLinks(block: TextBlock, candidates: Iterable<string>): TextBlock {
  const used = new Set(block.children.flatMap(marksOf));
  const drop = new Set(Array.from(candidates).filter(key => !used.has(key) && isLinkMark(block, key)));
  return drop.size ? { ...block, markDefs: defs(block).filter(def => !drop.has(def._key as string)) } : block;
}
/** Links in the selection are replaced by one new link annotation. Other annotations are kept. */
export function applyLink(block: TextBlock, selection: Selection, href: string, makeKey: KeyMaker = randomKey): TextBlock {
  const range = clamp(block, selection);
  if (range.start === range.end) return block;
  const linkKey = makeKey(), replaced = new Set<string>();
  const marked = mapRange({ ...block, markDefs: [...defs(block), { _type: 'link', _key: linkKey, href }] }, range, makeKey, (span, hit) => {
    if (!hit) return span;
    const keep = marksOf(span).filter(mark => { const link = isLinkMark(block, mark); if (link) replaced.add(mark); return !link; });
    return { ...span, marks: [...keep, linkKey] };
  });
  return pruneLinks(marked, replaced);
}
export function updateLinkHref(block: TextBlock, markKey: string, href: string): TextBlock {
  return { ...block, markDefs: defs(block).map(def => def._key === markKey && def._type === 'link' ? { ...def, href } : def) };
}
export function removeLink(block: TextBlock, markKey: string): TextBlock {
  if (!isLinkMark(block, markKey)) return block;
  const stripped = normalizeBlock({ ...block, children: block.children.map(span => ({ ...span, marks: marksOf(span).filter(mark => mark !== markKey) })) });
  return pruneLinks(stripped, [markKey]);
}
export function listLinks(block: TextBlock): { key: string; href: string; text: string }[] {
  return defs(block).filter(def => def._type === 'link' && typeof def._key === 'string').map(def => ({
    key: def._key as string, href: typeof def.href === 'string' ? def.href : '',
    text: block.children.filter(span => marksOf(span).includes(def._key as string)).map(span => span.text).join('')
  }));
}

/** Smallest replaced region between two texts. A caret hint places ambiguous pure insertions. */
export function diffText(before: string, after: string, caret?: number): { start: number; end: number; insert: string } {
  let start = 0;
  const shortest = Math.min(before.length, after.length);
  while (start < shortest && before[start] === after[start]) start++;
  let tail = 0;
  while (tail < shortest - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const grew = after.length - before.length;
  if (caret !== undefined && grew > 0 && start + tail === before.length) {
    const alt = caret - grew;
    if (alt >= 0 && alt <= before.length && before.slice(0, alt) + after.slice(alt, caret) + before.slice(alt) === after) return { start: alt, end: alt, insert: after.slice(alt, caret) };
  }
  return { start, end: before.length - tail, insert: after.slice(start, after.length - tail) };
}
/** Replace [start,end) with text. The new text inherits neighbouring marks, and links only when typed inside one. */
export function replaceRange(block: TextBlock, start: number, end: number, insert: string, makeKey: KeyMaker = randomKey): TextBlock {
  const range = clamp(block, { start, end });
  const source: Span[] = block.children.length ? block.children : [{ _type: 'span', _key: makeKey(), text: '', marks: [] }];
  const places = layout(splitSpansAt(splitSpansAt(source, range.start, makeKey), range.end, makeKey));
  const head = places.filter(item => item.end <= range.start), tail = places.filter(item => item.end > range.start && item.start >= range.end);
  const removed = places.filter(item => item.end > range.start && item.start < range.end);
  const before = head.filter(item => item.end > item.start).at(-1)?.span, after = tail.find(item => item.end > item.start)?.span;
  const base = removed[0]?.span ?? before ?? after;
  const inherited = base ? marksOf(base).filter(mark => !isLinkMark(block, mark) || (before && after && marksOf(after).includes(mark))) : [];
  const middle: Span[] = insert ? [{ _type: 'span', _key: makeKey(), text: insert, marks: inherited }] : [];
  const children = [...head.map(item => item.span), ...middle, ...tail.map(item => item.span)];
  return normalizeBlock({ ...block, children: children.length ? children : [{ ...source[0], text: '' }] });
}
export function setBlockText(block: TextBlock, nextText: string, caret?: number, makeKey: KeyMaker = randomKey): TextBlock {
  const change = diffText(blockText(block), nextText, caret);
  return change.start === change.end && !change.insert ? block : replaceRange(block, change.start, change.end, change.insert, makeKey);
}

export const setBlockStyle = (block: TextBlock, style: string): TextBlock => ({ ...block, style });
export function setBlockList(block: TextBlock, list: string | null, level?: number): TextBlock {
  const { listItem: _list, level: _level, ...rest } = block;
  return list ? { ...rest, listItem: list, level: Math.max(1, Math.min(MAX_LIST_LEVEL, level ?? (typeof block.level === 'number' ? block.level : 1))) } as TextBlock : rest as TextBlock;
}

export function moveNode<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list.slice();
  const next = list.slice(); const [item] = next.splice(from, 1); next.splice(to, 0, item); return next;
}
export const removeNode = <T,>(list: readonly T[], index: number): T[] => list.filter((_, i) => i !== index);
export const insertNode = <T,>(list: readonly T[], index: number, node: T): T[] => { const next = list.slice(); next.splice(Math.max(0, Math.min(index, next.length)), 0, node); return next; };

/** Deterministic unique keys for missing or duplicate `_key`s. Existing keys are never rewritten. */
export function uniqueKeys<T>(items: readonly T[], prefix: string): T[] {
  const taken = new Set<string>();
  for (const item of items) if (isObject(item) && typeof item._key === 'string' && item._key) taken.add(item._key);
  const used = new Set<string>();
  let counter = 0;
  return items.map(item => {
    if (!isObject(item)) return item;
    if (typeof item._key === 'string' && item._key && !used.has(item._key)) { used.add(item._key); return item; }
    let key: string;
    do key = `${prefix}${++counter}`; while (taken.has(key) || used.has(key));
    used.add(key);
    return { ...item, _key: key } as T;
  });
}
export function ensurePortableTextKeys(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const changed = uniqueKeys(value, 'b').map(node => {
    if (!isObject(node) || node._type !== 'block') return node;
    const children = Array.isArray(node.children) ? uniqueKeys(node.children, 's') : node.children;
    const markDefs = Array.isArray(node.markDefs) ? uniqueKeys(node.markDefs, 'm') : node.markDefs;
    return children === node.children && markDefs === node.markDefs ? node : { ...node, children, markDefs };
  });
  return changed.every((node, i) => node === value[i] || JSON.stringify(node) === JSON.stringify(value[i])) ? value : changed;
}

export type Segment = { key: string; text: string; decorators: string[]; href?: string; unknown: string[] };
/** Display-only view of a block: decorators, first link, and any marks this editor does not understand. */
export function segments(block: TextBlock): Segment[] {
  return block.children.filter(span => span.text).map(span => {
    const marks = marksOf(span), link = defs(block).find(def => def._type === 'link' && marks.includes(def._key as string));
    return {
      key: span._key, text: span.text, decorators: marks.filter(isDecorator),
      href: typeof link?.href === 'string' ? link.href : undefined,
      unknown: marks.filter(mark => !isDecorator(mark) && !isLinkMark(block, mark))
    };
  });
}
export function hasPortableTextContent(value: unknown): boolean {
  return Array.isArray(value) && value.some(node => !isObject(node) || node._type !== 'block' || (Array.isArray(node.children) && node.children.some(child => !isPlainSpan(child) || child.text.trim() !== '')));
}
