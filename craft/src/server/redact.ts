/** Audit-detail redaction. Detail is for identifiers, counts and hashes: never document content. */
const SECRET_KEY = /apikey|secret(?!ar)|passw(?:or)?d|passphrase|privatekey|signingkey|credential|token$|^authorization$|^cookie$/;
export const isSecretKey = (key: string): boolean => SECRET_KEY.test(key.toLowerCase().replace(/[^a-z0-9]/g, ''));

const MAX_DEPTH = 4, MAX_KEYS = 30, MAX_ITEMS = 50, MAX_STRING = 200;
/** Maximum serialized size of audit detail; larger input collapses to `{ truncated: true }`. */
export const MAX_AUDIT_DETAIL_BYTES = 4096;

/** Returns a bounded, secret-free, JSON-safe copy. Secret-looking keys keep the key with the value '[redacted]'. */
export function redact(value: unknown): Record<string, unknown> {
  const out = copy(value, 0);
  const object = out !== null && typeof out === 'object' && !Array.isArray(out) ? out as Record<string, unknown> : { value: out };
  return Buffer.byteLength(JSON.stringify(object), 'utf8') > MAX_AUDIT_DETAIL_BYTES ? { truncated: true } : object;
}
function copy(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...` : value;
  if (depth >= MAX_DEPTH || typeof value !== 'object') return typeof value === 'object' ? '[depth]' : null;
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map(item => copy(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).slice(0, MAX_KEYS)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) continue;
    out[key.slice(0, MAX_STRING)] = isSecretKey(key) ? '[redacted]' : copy(descriptor.value, depth + 1);
  }
  return out;
}
