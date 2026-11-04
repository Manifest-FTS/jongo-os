/** Safe-JSON inspection, canonical serialization and hashing. Pure; no DB or network. */
import { createHash } from 'node:crypto';

export const JSON_LIMITS = Object.freeze({ depth: 32, nodes: 20_000, array: 2_000, properties: 200, string: 100_000 });
/** Canonical (sorted-key, compact) UTF-8 size cap for one stored document payload. */
export const MAX_DOCUMENT_BYTES = 512 * 1024;
export const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
/** NUL or an unpaired UTF-16 surrogate. */
export const MALFORMED_UTF16 = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

export type JsonViolation = 'not_json' | 'unsafe_key' | 'unicode' | 'number' | 'depth_limit' | 'node_limit' | 'collection_limit' | 'string_limit' | 'cycle';

/** Returns the first violation or null. Reads property descriptors only: getters, toJSON and proxies' traps are never run on data. */
export function findJsonViolation(input: unknown): JsonViolation | null {
  let nodes = 0;
  const ancestors = new Set<object>();
  const walk = (value: unknown, depth: number): JsonViolation | null => {
    if (++nodes > JSON_LIMITS.nodes) return 'node_limit';
    if (depth > JSON_LIMITS.depth) return 'depth_limit';
    if (value === null || typeof value === 'boolean') return null;
    if (typeof value === 'string') return value.length > JSON_LIMITS.string ? 'string_limit' : MALFORMED_UTF16.test(value) ? 'unicode' : null;
    if (typeof value === 'number') return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)) ? null : 'number';
    if (typeof value !== 'object') return 'not_json';
    if (ancestors.has(value)) return 'cycle';
    const array = Array.isArray(value);
    const proto = Object.getPrototypeOf(value);
    if (!array && proto !== Object.prototype && proto !== null) return 'not_json';
    if (Object.getOwnPropertySymbols(value).length) return 'not_json';
    const names = Object.getOwnPropertyNames(value);
    ancestors.add(value);
    try {
      if (array) {
        const list = value as unknown[];
        if (list.length > JSON_LIMITS.array) return 'collection_limit';
        if (names.length !== list.length + 1) return 'not_json'; // sparse or extra props
        for (let i = 0; i < list.length; i++) {
          const d = Object.getOwnPropertyDescriptor(list, String(i));
          if (!d || !('value' in d)) return 'not_json';
          const found = walk(d.value, depth + 1);
          if (found) return found;
        }
        return null;
      }
      if (names.length > JSON_LIMITS.properties) return 'collection_limit';
      for (const key of names) {
        if (UNSAFE_KEYS.has(key)) return 'unsafe_key';
        if (key.length > JSON_LIMITS.string || MALFORMED_UTF16.test(key)) return 'unicode';
        const d = Object.getOwnPropertyDescriptor(value, key)!;
        if (!d.enumerable || !('value' in d)) return 'not_json';
        const found = walk(d.value, depth + 1);
        if (found) return found;
      }
      return null;
    } finally { ancestors.delete(value); }
  };
  try { return walk(input, 0); } catch { return 'not_json'; }
}

export const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** Compact JSON with keys sorted at every depth. Input must already have passed `findJsonViolation`. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean': return value ? 'true' : 'false';
    case 'number': return JSON.stringify(value);
    case 'string': return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
    }
    default: throw new TypeError('not JSON');
  }
}

export const sha256Hex = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
