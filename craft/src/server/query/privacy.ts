/**
 * Public view of a document under Craft descriptors. Allowlist, not blocklist: an undeclared field cannot be classified,
 * so it is treated as private. Field-level `private: true` removes the field at any depth.
 */
import type { Descriptor, FieldDefinition, TypeDefinition } from '../../schema.js';

type Doc = Record<string, unknown>;
const ENVELOPE = new Set(['_id', '_type', '_rev', '_createdAt', '_updatedAt']);
const NESTED_SYSTEM = new Set(['_type', '_key']);

const isObject = (value: unknown): value is Doc => typeof value === 'object' && value !== null && !Array.isArray(value);

function matchMember(item: unknown, members: readonly Descriptor[]): Descriptor | undefined {
  if (members.length === 1) return members[0];
  if (typeof item === 'string') return members.find(m => ['string', 'text', 'url', 'date', 'datetime', 'enum'].includes(m.type));
  if (typeof item === 'number') return members.find(m => m.type === 'number');
  if (typeof item === 'boolean') return members.find(m => m.type === 'boolean');
  if (!isObject(item)) return undefined;
  const type = item._type;
  if (typeof type === 'string') {
    return members.find(m => (m.type === 'object' && m.objectType === type) || (m.type === 'reference' && type === 'reference')
      || (m.type === 'image' && type === 'image') || (m.type === 'slug' && type === 'slug'));
  }
  const untyped = members.filter(m => m.type === 'object' && m.objectType === undefined);
  return untyped.length === 1 ? untyped[0] : undefined;
}

function pick(value: Doc, keys: readonly string[]): Doc {
  const out: Doc = {};
  for (const key of keys) if (Object.hasOwn(value, key)) out[key] = value[key];
  return out;
}
const REFERENCE_KEYS = ['_type', '_ref', '_weak', '_key'];

function strip(value: unknown, d: Descriptor): unknown {
  switch (d.type) {
    case 'object': return isObject(value) ? stripObject(value, d.fields, false) : undefined;
    case 'array': return Array.isArray(value) ? value.flatMap(item => {
      const member = matchMember(item, d.of);
      if (!member) return [];
      const kept = strip(item, member);
      return kept === undefined ? [] : [kept];
    }) : undefined;
    case 'reference': return isObject(value) ? pick(value, REFERENCE_KEYS) : undefined;
    case 'image': {
      if (!isObject(value)) return undefined;
      const out = pick(value, ['_type', '_key']);
      if (isObject(value.asset)) out.asset = pick(value.asset, REFERENCE_KEYS);
      for (const name of ['alt', 'caption']) if (typeof value[name] === 'string') out[name] = value[name];
      return out;
    }
    case 'slug': return isObject(value) ? pick(value, ['_type', 'current']) : undefined;
    case 'portableText': return Array.isArray(value) ? value : undefined;
    case 'number': return typeof value === 'number' ? value : undefined;
    case 'boolean': return typeof value === 'boolean' ? value : undefined;
    default: return typeof value === 'string' ? value : undefined;
  }
}

function stripObject(value: Doc, fields: readonly FieldDefinition[], top: boolean): Doc {
  const out: Doc = {};
  for (const key of Object.keys(value)) {
    if (key.startsWith('_')) {
      if (top ? ENVELOPE.has(key) : NESTED_SYSTEM.has(key)) out[key] = value[key];
      continue;
    }
    const field = fields.find(f => f.name === key);
    if (!field || field.private) continue;
    const kept = strip(value[key], field);
    if (kept !== undefined) out[key] = kept;
  }
  return out;
}

/** The public view, or null when the type is not registered (privacy cannot be decided). */
export function toPublicDocument(doc: Doc, registry: ReadonlyMap<string, TypeDefinition>): Doc | null {
  const definition = typeof doc._type === 'string' ? registry.get(doc._type) : undefined;
  return definition ? stripObject(doc, definition.fields, true) : null;
}
