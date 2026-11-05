/** Pure document helpers: keys, immutable edits, array operations and reference resolution. */
import { IMAGE_ASSET_TYPE, type Descriptor, type FieldDefinition, type TypeDefinition } from './schema.js';
import { ensurePortableTextKeys, randomKey, uniqueKeys, type JsonObject, type KeyMaker } from './portable-text.js';

export type ContentDocument = { _id: string; _type: string } & JsonObject;
export type ImageAssetDocument = { _id: string; _type: typeof IMAGE_ASSET_TYPE; url: string; originalFilename?: string; title?: string; altText?: string } & JsonObject;
export type Reference = { _type: 'reference'; _ref: string; _weak?: boolean; _key?: string };
export type Slug = { _type: 'slug'; current: string };

export const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a).filter(key => a[key] !== undefined), other = Object.keys(b).filter(key => b[key] !== undefined);
    return keys.length === other.length && keys.every(key => deepEqual(a[key], b[key]));
  }
  return false;
}
/** Setting `undefined` removes the key, like clearing a field in Sanity. */
export function setField(object: JsonObject | undefined, name: string, value: unknown): JsonObject {
  const next = { ...object };
  if (value === undefined) delete next[name]; else next[name] = value;
  return next;
}

// ---- array operations (immutable; out-of-range requests return an equal copy) ----
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list.slice();
  const next = list.slice(); const [item] = next.splice(from, 1); next.splice(to, 0, item); return next;
}
export const removeItem = <T,>(list: readonly T[], index: number): T[] => list.filter((_, i) => i !== index);
export const appendItem = <T,>(list: readonly T[] | undefined, item: T): T[] => [...(list ?? []), item];
export const replaceItem = <T,>(list: readonly T[], index: number, item: T): T[] => list.map((current, i) => i === index ? item : current);
export const canAddItem = (d: Extract<Descriptor, { type: 'array' }>, length: number) => length < (d.maxItems ?? 2000);
/** Object-like members carry a stable `_key`; primitives (strings, numbers) cannot. */
export const isKeyedMember = (member: Descriptor) => member.type === 'object' || member.type === 'reference' || member.type === 'image';
export function memberFor(d: Extract<Descriptor, { type: 'array' }>, item: unknown): Descriptor | undefined {
  if (d.of.length === 1) return d.of[0];
  return d.of.find(candidate => {
    if (candidate.type === 'object') return isObject(item) && item._type === candidate.objectType;
    if (candidate.type === 'reference') return isObject(item) && item._type === 'reference';
    if (candidate.type === 'image') return isObject(item) && item._type === 'image';
    if (candidate.type === 'number') return typeof item === 'number';
    if (candidate.type === 'boolean') return typeof item === 'boolean';
    return typeof item === 'string';
  });
}
export const memberTitle = (member: Descriptor) => member.title ?? (member.type === 'object' ? member.objectType ?? 'Item' : member.type === 'reference' ? 'Reference' : member.type === 'image' ? 'Image' : 'Item');
/** New array item for a non-reference, non-image member. References and images are created by pickers. */
export function newItem(member: Descriptor, makeKey: KeyMaker = randomKey): unknown {
  switch (member.type) {
    case 'object': return { ...(member.objectType ? { _type: member.objectType } : {}), _key: makeKey() };
    case 'number': return 0;
    case 'boolean': return false;
    default: return '';
  }
}
export const newReference = (documentId: string, weak?: boolean, key?: string): Reference => ({ _type: 'reference', ...(key ? { _key: key } : {}), _ref: logicalId(documentId), ...(weak ? { _weak: true } : {}) });
export const newImage = (assetId: string, key?: string): JsonObject => ({ _type: 'image', ...(key ? { _key: key } : {}), asset: { _type: 'reference', _ref: logicalId(assetId) } });

// ---- keys ----
/** Fill missing or duplicate `_key`s with deterministic values so server and client agree. */
export function ensureKeys(schema: TypeDefinition, doc: ContentDocument): ContentDocument {
  const out: JsonObject = { ...doc };
  const walk = (d: Descriptor, value: unknown): unknown => {
    if (d.type === 'portableText') return ensurePortableTextKeys(value);
    if (d.type === 'object') return isObject(value) ? fields(d.fields, value) : value;
    if (d.type === 'array' && Array.isArray(value)) {
      const items = value.map(item => { const member = memberFor(d, item); return member ? walk(member, item) : item; });
      return d.of.some(isKeyedMember) ? uniqueKeys(items, 'k') : items;
    }
    return value;
  };
  const fields = (definitions: readonly FieldDefinition[], value: JsonObject): JsonObject => {
    const next = { ...value };
    for (const field of definitions) if (next[field.name] !== undefined) next[field.name] = walk(field, next[field.name]);
    return next;
  };
  return fields(schema.fields, out) as ContentDocument;
}

// ---- references ----
export const logicalId = (id: string) => id.startsWith('drafts.') ? id.slice(7) : id;
export type IndexEntry = { _id: string; _type: string; doc: JsonObject; draft: boolean };
export type ReferenceIndex = Map<string, IndexEntry>;
/** Keyed by logical ID (no `drafts.` prefix). A draft variant wins over its published twin. */
export function createReferenceIndex(documents: readonly JsonObject[], assets: readonly JsonObject[] = []): ReferenceIndex {
  const index: ReferenceIndex = new Map();
  for (const doc of [...assets, ...documents]) {
    if (typeof doc._id !== 'string' || typeof doc._type !== 'string') continue;
    const key = logicalId(doc._id), draft = doc._id.startsWith('drafts.'), current = index.get(key);
    if (!current || (draft && !current.draft)) index.set(key, { _id: doc._id, _type: doc._type, doc, draft });
  }
  return index;
}
export type Resolution = { status: 'empty' | 'missing' | 'draftPrefix' | 'type' | 'ok'; entry?: IndexEntry };
export function resolveReference(index: ReferenceIndex, ref: unknown, to: readonly string[]): Resolution {
  if (!isObject(ref) || typeof ref._ref !== 'string' || !ref._ref) return { status: 'empty' };
  if (ref._ref.startsWith('drafts.')) return { status: 'draftPrefix' };
  const entry = index.get(ref._ref);
  if (!entry) return { status: 'missing' };
  return to.includes(entry._type) ? { status: 'ok', entry } : { status: 'type', entry };
}
export function slugify(text: string): string {
  return text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96);
}
export function documentTitle(doc: JsonObject, schema?: TypeDefinition): string {
  const field = schema?.preview?.title ?? schema?.fields.find(item => item.type === 'string')?.name;
  const value = field ? doc[field] : undefined;
  if (typeof value === 'string' && value.trim()) return value;
  if (isObject(value) && typeof value.current === 'string' && value.current) return value.current;
  for (const name of ['originalFilename', 'title']) if (typeof doc[name] === 'string' && doc[name]) return doc[name] as string;
  return typeof doc._id === 'string' ? logicalId(doc._id) : 'Untitled';
}
export type Candidate = { id: string; type: string; title: string; entry: IndexEntry };
/** Search references by title, type or ID over supplied documents of the allowed types only. */
export function searchReferences(index: ReferenceIndex, to: readonly string[], query: string, schemas: ReadonlyMap<string, TypeDefinition>): Candidate[] {
  const needle = query.trim().toLowerCase();
  return Array.from(index.entries()).filter(([, entry]) => to.includes(entry._type)).map(([id, entry]) => ({ id, type: entry._type, title: documentTitle(entry.doc, schemas.get(entry._type)), entry }))
    .filter(item => !needle || `${item.title} ${item.type} ${item.id}`.toLowerCase().includes(needle))
    .sort((a, b) => a.title.localeCompare(b.title));
}
