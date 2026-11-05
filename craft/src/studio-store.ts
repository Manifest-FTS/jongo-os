/** Persistence contract of the Studio. Pure types and helpers: no React, no server code, no network. The host implements `StudioStore`. */
import type { ContentDocument } from './content-ops.js';

export type StudioFailureCode = 'conflict' | 'invalid' | 'denied' | 'unavailable';
export type StudioFieldError = { path: readonly (string | number)[]; message: string };
/** Typed failure. `message` is shown to the editor, so it must not contain SQL, driver text or other internals. */
export type StudioFailure = { ok: false; code: StudioFailureCode; message: string; fieldErrors?: readonly StudioFieldError[] };
export type StudioResult<T> = ({ ok: true } & T) | StudioFailure;

export type StudioVariant = 'draft' | 'published';
export type StudioDocSummary = {
  id: string; type: string; title: string;
  /** Which stored version an editor sees first: the draft when one exists, else the published version. */
  variant: StudioVariant;
  /** A published version exists (alongside a draft when `variant` is 'draft'). */
  hasPublished: boolean;
  updatedAt?: string;
};
export type StudioRecord = {
  doc: ContentDocument;
  /** Revision and lock version of the head (the draft if there is one, else the published version): the compare-and-set precondition. */
  nativeRev: string;
  lockVersion: number;
  variant: StudioVariant;
  /** Precondition for `unpublish`; present only while a published version exists. */
  published?: { nativeRev: string; lockVersion: number };
  /** A draft exists that differs from the published version. */
  publishedDiffers?: boolean;
};
export type StudioExpect = {
  nativeRev?: string; lockVersion?: number;
  /** Idempotency key chosen by the Studio per attempt; identical for an immediate retry of the same request. */
  mutationKey: string;
};

export interface StudioStore {
  list(): Promise<StudioResult<{ documents: StudioDocSummary[] }>>;
  load(id: string): Promise<StudioResult<StudioRecord>>;
  saveDraft(doc: ContentDocument, expect: StudioExpect): Promise<StudioResult<StudioRecord>>;
  publish(id: string, expect: StudioExpect): Promise<StudioResult<StudioRecord>>;
  unpublish(id: string, expect: StudioExpect): Promise<StudioResult<StudioRecord>>;
  discardDraft(id: string, expect: StudioExpect): Promise<StudioResult<StudioRecord>>;
}

export const unavailableFailure = (message = 'The studio could not reach storage. Nothing was confirmed as saved; try again.'): StudioFailure => ({ ok: false, code: 'unavailable', message });

/** Never rejects: a thrown error or a malformed result becomes an `unavailable` failure, so the UI always has a typed outcome. */
export async function settle<T>(call: () => Promise<StudioResult<T>>): Promise<StudioResult<T>> {
  try {
    const result = await call();
    if (typeof result === 'object' && result !== null && typeof (result as { ok?: unknown }).ok === 'boolean') {
      if (result.ok) return result;
      const failure = result as StudioFailure;
      const code: StudioFailureCode = failure.code === 'conflict' || failure.code === 'invalid' || failure.code === 'denied' ? failure.code : 'unavailable';
      return { ok: false, code, message: typeof failure.message === 'string' && failure.message ? failure.message : unavailableFailure().message, ...(Array.isArray(failure.fieldErrors) ? { fieldErrors: failure.fieldErrors } : {}) };
    }
  } catch { /* falls through */ }
  return unavailableFailure();
}

/** JSON with sorted object keys, so equal content yields equal text. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** 128-bit random key in the alphabet the server accepts (`[A-Za-z0-9._:/@+=~-]`, at most 128 characters). */
export function newMutationKey(prefix = 'studio'): string {
  const bytes = new Uint8Array(16);
  const crypto = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  if (crypto?.getRandomValues) crypto.getRandomValues(bytes); else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return `${prefix}-${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** One key per attempt: the same request fingerprint (operation, document, precondition, body) reuses the key, so a retry is idempotent. Any change makes a new key. */
export class MutationKeys {
  private last: { fingerprint: string; key: string } | null = null;
  keyFor(operation: string, id: string, expect: { nativeRev?: string; lockVersion?: number }, body?: unknown): string {
    const fingerprint = stableJson([operation, id, expect.nativeRev ?? null, expect.lockVersion ?? null, body ?? null]);
    if (this.last?.fingerprint !== fingerprint) this.last = { fingerprint, key: newMutationKey(operation) };
    return this.last.key;
  }
  /** After a confirmed outcome the next request can never be a retry of this one. */
  clear(): void { this.last = null; }
}

export const statusLabel = (record: Pick<StudioRecord, 'variant' | 'published'>): 'Published' | 'Draft' => record.variant === 'published' ? 'Published' : 'Draft';
export function statusDetail(record: Pick<StudioRecord, 'variant' | 'published' | 'publishedDiffers'>): string {
  if (record.variant === 'published') return 'Published and up to date. Editing creates a draft.';
  return record.published ? 'A published version exists; this draft has changes that are not published.' : 'Never published. This is a draft.';
}
