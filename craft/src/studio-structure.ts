/** Desk structure: which documents and lists the Studio menu offers and how they nest (the Jongo Craft counterpart of Sanity's Desk Structure). Pure data, no React. */
import type { TypeDefinition } from './schema.js';

export type StructureItem =
  /** One fixed document, opened directly. */
  | { kind: 'document'; type: string; documentId: string; title?: string }
  /** The list of all documents of a type. */
  | { kind: 'documents'; type: string; title?: string }
  /** A labelled section of the menu. */
  | { kind: 'group'; title: string; items: readonly StructureItem[] }
  | { kind: 'divider' };
export type CraftStructure = { title?: string; items: readonly StructureItem[] };

const MAX_DEPTH = 3;

export const craftStructure = {
  /** The menu. Title defaults to "Content". Checks every type against `schemas` so a typo fails when the site starts, not in the editor. */
  define(items: readonly StructureItem[], schemas: readonly Pick<TypeDefinition, 'name'>[], options: { title?: string } = {}): CraftStructure {
    const known = new Set(schemas.map(schema => schema.name));
    const documents = new Set<string>();
    const walk = (list: readonly StructureItem[], depth: number) => {
      if (depth > MAX_DEPTH || !list.length) throw new Error('Invalid structure');
      for (const item of list) {
        if (item.kind === 'group') {
          if (!item.title.trim()) throw new Error('Invalid structure');
          walk(item.items, depth + 1);
        } else if (item.kind === 'divider') continue;
        else {
          if (!known.has(item.type)) throw new Error(`Structure refers to an unregistered type "${item.type}"`);
          if (item.kind === 'document') {
            const key = `${item.type}/${item.documentId}`;
            if (!item.documentId || documents.has(key)) throw new Error('Invalid structure');
            documents.add(key);
          }
        }
      }
    };
    walk(items, 1);
    return { ...(options.title ? { title: options.title } : {}), items };
  },
  document: (type: string, documentId: string, title?: string): StructureItem => ({ kind: 'document', type, documentId, ...(title ? { title } : {}) }),
  documents: (type: string, title?: string): StructureItem => ({ kind: 'documents', type, ...(title ? { title } : {}) }),
  group: (title: string, items: readonly StructureItem[]): StructureItem => ({ kind: 'group', title, items }),
  divider: (): StructureItem => ({ kind: 'divider' })
};

/** The menu a studio shows when the host gives none: one list per type. */
export const defaultStructure = (schemas: readonly Pick<TypeDefinition, 'name'>[]): CraftStructure => ({ items: schemas.map(schema => craftStructure.documents(schema.name)) });

type Leaf = Extract<StructureItem, { kind: 'document' | 'documents' }>;
function* leaves(items: readonly StructureItem[]): Generator<Leaf> {
  for (const item of items) {
    if (item.kind === 'group') yield* leaves(item.items);
    else if (item.kind !== 'divider') yield item;
  }
}

/** Every document type the menu can reach. */
export const structureTypes = (structure: CraftStructure): Set<string> => new Set([...leaves(structure.items)].map(leaf => leaf.type));
/** Where the Studio opens when the address names nothing: the first entry of the menu. */
export function structureTarget(structure: CraftStructure | undefined): { type: string; id?: string } | undefined {
  const first = structure ? leaves(structure.items).next().value : undefined;
  return first ? { type: first.type, ...(first.kind === 'document' ? { id: first.documentId } : {}) } : undefined;
}
/** The menu entry that shows this type and document: the exact document entry if there is one, else the list for the type. */
export function structureMatch(structure: CraftStructure, type: string, id?: string): Leaf | undefined {
  const all = [...leaves(structure.items)];
  return all.find(leaf => leaf.kind === 'document' && leaf.type === type && leaf.documentId === id) ?? all.find(leaf => leaf.kind === 'documents' && leaf.type === type);
}
/** A fixed document that has its own entry needs no list beside it. */
export const showsDocumentList = (structure: CraftStructure | undefined, type: string, id?: string): boolean => {
  const match = structure && structureMatch(structure, type, id);
  return !match || match.kind === 'documents';
};
