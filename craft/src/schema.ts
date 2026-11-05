/** Descriptor names and shapes follow jongo/apps/web/src/lib/cms/schema.ts so schemas stay portable.
 * Craft-only additions: `image` (asset picker, no upload), `slug.source`, `reference.weak`, `preview`. */
type Common = { title?: string; description?: string; required?: boolean; publishRequired?: boolean; private?: boolean };
export type Descriptor =
  | (Common & { type: 'string' | 'text' | 'url' | 'date' | 'datetime'; minLength?: number; maxLength?: number })
  | (Common & { type: 'number'; min?: number; max?: number; integer?: boolean })
  | (Common & { type: 'boolean' | 'portableText' })
  | (Common & { type: 'slug'; maxLength?: number; source?: string })
  | (Common & { type: 'enum'; options: readonly string[] })
  | (Common & { type: 'reference'; to: readonly string[]; weak?: boolean })
  | (Common & { type: 'image'; altRequired?: boolean })
  | (Common & { type: 'object'; objectType?: string; fields: readonly FieldDefinition[] })
  | (Common & { type: 'array'; of: readonly Descriptor[]; minItems?: number; maxItems?: number });
export type FieldDefinition = Descriptor & { name: string };
export type TypeDefinition = {
  name: string; type: 'document'; title?: string; schemaVersion: number;
  fields: readonly FieldDefinition[];
  /** Field names used for list titles; falls back to the first string field. */
  preview?: { title?: string };
};
export const IMAGE_ASSET_TYPE = 'sanity.imageAsset';

export function defineField<const T extends FieldDefinition>(field: T): T { return field; }
export function defineArrayMember<const T extends Descriptor>(member: T): T { return member; }
export function defineType<const T extends TypeDefinition>(schema: T): T { return schema; }

const DESCRIPTOR_TYPES = ['string', 'text', 'url', 'date', 'datetime', 'number', 'boolean', 'slug', 'portableText', 'enum', 'reference', 'image', 'object', 'array'];
export const memberSignature = (member: Descriptor) => member.type === 'object' ? member.objectType ?? 'object' : member.type;

/** Code-owned descriptors fail at registration, never during content validation. */
export function createContentRegistry(schemas: readonly TypeDefinition[]): Map<string, TypeDefinition> {
  const fail = (): never => { throw new Error('Invalid or duplicate content schema'); };
  const registry = new Map<string, TypeDefinition>();
  function checkFields(fields: readonly FieldDefinition[]) {
    if (!Array.isArray(fields)) fail();
    const seen = new Set<string>();
    for (const field of fields) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(field.name) || seen.has(field.name)) throw new Error('Invalid content field');
      seen.add(field.name); check(field);
    }
  }
  function check(d: Descriptor) {
    if (!DESCRIPTOR_TYPES.includes(d.type)) throw new Error('Invalid content field');
    if (d.type === 'enum' && (!Array.isArray(d.options) || !d.options.length || d.options.some(o => typeof o !== 'string') || new Set(d.options).size !== d.options.length)) throw new Error('Invalid content field');
    if (d.type === 'reference' && (!Array.isArray(d.to) || !d.to.length || d.to.some(t => typeof t !== 'string' || !t))) throw new Error('Invalid content field');
    if (d.type === 'object') checkFields(d.fields);
    if (d.type === 'array') {
      if (!Array.isArray(d.of) || !d.of.length) throw new Error('Invalid content field');
      const signatures = new Set<string>();
      for (const member of d.of) {
        check(member);
        const signature = memberSignature(member);
        if (signatures.has(signature) || (d.of.length > 1 && member.type === 'object' && !member.objectType) || member.type === 'array') throw new Error('Invalid content field');
        signatures.add(signature);
      }
    }
    const bounds = d as unknown as Record<string, unknown>;
    for (const [low, high] of [['min', 'max'], ['minLength', 'maxLength'], ['minItems', 'maxItems']]) {
      for (const name of [low, high]) if (bounds[name] !== undefined && (typeof bounds[name] !== 'number' || !Number.isFinite(bounds[name]))) throw new Error('Invalid content field');
      if (typeof bounds[low] === 'number' && typeof bounds[high] === 'number' && bounds[low] > bounds[high]) throw new Error('Invalid content field');
    }
  }
  for (const schema of schemas) {
    if (!/^[a-zA-Z][\w.-]*$/.test(schema.name) || registry.has(schema.name) || schema.type !== 'document' || !(schema.schemaVersion >= 1)) fail();
    checkFields(schema.fields);
    registry.set(schema.name, schema);
  }
  return registry;
}
