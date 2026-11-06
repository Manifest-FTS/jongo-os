/** Persistence contract of the Studio. Pure types and helpers: no React, no server code, no network. The host implements `StudioStore`. */
import type { ContentDocument } from './content-ops.js';
import { UPLOAD_MESSAGES, type StudioAssetDocument, type UploadErrorCode } from './media-contract.js';

export type StudioFailureCode = 'conflict' | 'invalid' | 'denied' | 'unavailable';
export type StudioFieldError = { path: readonly (string | number)[]; message: string };
/** Typed failure. `message` is shown to the editor, so it must not contain SQL, driver text or other internals. */
export type StudioFailure = { ok: false; code: StudioFailureCode; message: string; fieldErrors?: readonly StudioFieldError[] };
export type StudioResult<T> = ({ ok: true } & T) | StudioFailure;

/** What the signed-in person may do. A hint for the interface only: the host's store must refuse the same actions itself. Both default to true. */
export type StudioPermissions = {
  /** false: view-only. Fields are disabled and Save, Duplicate, Discard, Delete and Publish are not offered. */
  canWrite?: boolean;
  /** false: Publish, Unpublish and Delete are not offered. */
  canPublish?: boolean;
};
export type StudioVariant = 'draft' | 'published';
/** Who did something. `id` is opaque; `name` is a display label (hosts without real identities send a generic one, never a raw session id). */
export type StudioActor = { id: string; name?: string; avatarUrl?: string };
export type StudioStamp = { at: string; by?: StudioActor };
export type StudioHistoryEntry = { at: string; action: 'save' | 'publish' | 'unpublish' | 'discard' | 'delete' | (string & {}); by?: StudioActor };
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
  /** When and by whom the published version was last published. Present only while a published version exists. */
  lastPublished?: StudioStamp;
  /** When and by whom the head (the draft if there is one, else the published version) was last written. */
  lastEdited?: StudioStamp;
};
export type StudioExpect = {
  nativeRev?: string; lockVersion?: number;
  /** Idempotency key chosen by the Studio per attempt; identical for an immediate retry of the same request. */
  mutationKey: string;
};

/** Upload failures carry a code the Studio can phrase; `missing` (settings NAMES only) is set when the host has no storage configured. */
export type UploadFailure = { ok: false; code: UploadErrorCode; message: string; missing?: readonly string[] };
export type UploadResult<T> = ({ ok: true } & T) | UploadFailure;
/** Everything the browser needs to PUT one file straight to storage, plus the proof it must hand back to `completeUpload`. */
export type UploadTicket = { uploadUrl: string; headers: Record<string, string>; key: string; token: string; expiresAt: string; contentType: string; size: number };
export type UploadRequest = { filename: string; contentType: string; size: number };
export type UploadCompletion = { key: string; token: string; contentType: string; size: number; /** The name the file had when the ticket was requested; the token covers it. */ filename: string };

export interface StudioStore {
  list(): Promise<StudioResult<{ documents: StudioDocSummary[] }>>;
  load(id: string): Promise<StudioResult<StudioRecord>>;
  saveDraft(doc: ContentDocument, expect: StudioExpect): Promise<StudioResult<StudioRecord>>;
  publish(id: string, expect: StudioExpect): Promise<StudioResult<StudioRecord>>;
  unpublish(id: string, expect: StudioExpect): Promise<StudioResult<StudioRecord>>;
  discardDraft(id: string, expect: StudioExpect): Promise<StudioResult<StudioRecord>>;
  /** Read-only revision/activity list of one document, newest first. The Studio offers History only when this exists. */
  history?(id: string): Promise<StudioResult<{ entries: StudioHistoryEntry[] }>>;
  /** Creates a NEW draft copy and returns it. The host owns id generation and the copy rules. The Studio offers Duplicate only when this exists. */
  duplicate?(id: string, expect?: StudioExpect): Promise<StudioResult<StudioRecord>>;
  /** Removes the document (draft and published). The Studio offers Delete only when this exists. */
  delete?(id: string, expect: StudioExpect): Promise<StudioResult<{ id: string }>>;
  /** Uploaded assets, newest first is decided by the Studio. The image picker lists them next to the host's own asset library. */
  listAssets?(): Promise<StudioResult<{ assets: StudioAssetDocument[] }>>;
  /** Asks the host for a one-file upload ticket. The host chooses the storage key; the browser never does. The Studio offers Upload only when both upload methods exist. */
  requestUpload?(input: UploadRequest): Promise<UploadResult<UploadTicket>>;
  /** After the browser's PUT: the host verifies the stored object and creates the asset document (idempotent per key). */
  completeUpload?(input: UploadCompletion): Promise<UploadResult<{ asset: StudioAssetDocument }>>;
}

export const unavailableFailure = (message = 'Jongo Craft could not reach storage. Nothing was confirmed as saved; try again.'): StudioFailure => ({ ok: false, code: 'unavailable', message });

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

const UPLOAD_CODES: ReadonlySet<string> = new Set(Object.keys(UPLOAD_MESSAGES));
/** Never rejects: a thrown error or a malformed result becomes an `unavailable` upload failure. */
export async function settleUpload<T>(call: () => Promise<UploadResult<T>>): Promise<UploadResult<T>> {
  try {
    const result = await call();
    if (typeof result === 'object' && result !== null && typeof (result as { ok?: unknown }).ok === 'boolean') {
      if (result.ok) return result;
      const failure = result as UploadFailure;
      const code = UPLOAD_CODES.has(failure.code) ? failure.code : 'unavailable';
      return { ok: false, code, message: typeof failure.message === 'string' && failure.message ? failure.message : UPLOAD_MESSAGES[code], ...(Array.isArray(failure.missing) ? { missing: failure.missing } : {}) };
    }
  } catch { /* falls through */ }
  return { ok: false, code: 'unavailable', message: UPLOAD_MESSAGES.unavailable };
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

/** Deterministic `17 Aug 2026, 14:32` (24-hour). `timeZone` defaults to the runtime's; pass 'UTC' for output that must match between server and browser. Empty for an unparsable value. */
export function formatStamp(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) }).formatToParts(date);
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? '';
  return `${part('day')} ${part('month')} ${part('year')}, ${part('hour')}:${part('minute')}`;
}
/** `14:32` in the runtime's time zone (or `timeZone`). Empty for an unparsable value. */
export function formatClock(iso: string, timeZone?: string): string {
  const full = formatStamp(iso, timeZone);
  return full ? full.slice(full.indexOf(',') + 2) : '';
}
/** One or two capital letters for an avatar chip; empty when there is no usable name. */
export function initialsOf(name: string | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const first = Array.from(words[0])[0] ?? '';
  const last = words.length > 1 ? Array.from(words[words.length - 1])[0] ?? '' : '';
  return (first + last).toUpperCase();
}
/** The normalized URL only for a plain https address (no credentials, bounded length); anything else is dropped. */
export function safeAvatarUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

export const statusLabel = (record: Pick<StudioRecord, 'variant' | 'published'>): 'Published' | 'Draft' => record.variant === 'published' ? 'Published' : 'Draft';
const HISTORY_LABELS: Readonly<Record<string, string>> = { save: 'Saved draft', publish: 'Published', unpublish: 'Unpublished', discard: 'Discarded draft', delete: 'Deleted' };
/** Display text for a history action; unknown actions from a newer host read as a neutral 'Changed'. */
export const historyLabel = (action: string): string => Object.hasOwn(HISTORY_LABELS, action) ? HISTORY_LABELS[action] : 'Changed';
export function statusDetail(record: Pick<StudioRecord, 'variant' | 'published' | 'publishedDiffers'>): string {
  if (record.variant === 'published') return 'Published and up to date. Editing creates a draft.';
  return record.published ? 'A published version exists; this draft has changes that are not published.' : 'Never published. This is a draft.';
}
