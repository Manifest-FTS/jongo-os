/**
 * Media storage for S3-compatible buckets (Backblaze B2): AWS Signature V4, presigned PUT, signed HEAD / ranged GET / DELETE,
 * the storage key builder, and magic-byte sniffing with small image-dimension readers. No dependencies beyond node:crypto and
 * the global fetch (injectable for tests). Server-only: this module reads secrets and must never be imported by client code.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { DEFAULT_MEDIA_LIMITS, isAllowedMediaType, maxBytesFor, mediaExtensionFor, mediaKindFor, type AllowedMediaType, type MediaKind, type MediaLimits } from '../media-contract.js';

export type MediaStorageErrorCode = 'invalid' | 'not_found' | 'denied' | 'unavailable';
/** Messages never contain the endpoint, a key id, a secret, a signed URL or response text. */
export class MediaStorageError extends Error {
  readonly code: MediaStorageErrorCode;
  constructor(code: MediaStorageErrorCode, message: string) {
    super(message);
    this.name = 'MediaStorageError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// AWS Signature Version 4
// ---------------------------------------------------------------------------------------------------------------------
export const EMPTY_PAYLOAD_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
const ALGORITHM = 'AWS4-HMAC-SHA256';

const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();

/** RFC 3986 percent-encoding as SigV4 requires: only A-Z a-z 0-9 - _ . ~ stay; `keepSlash` leaves `/` for a path. */
export function uriEncode(value: string, keepSlash = false): string {
  const encoded = encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? encoded.replace(/%2F/g, '/') : encoded;
}
/** `20130524T000000Z` */
export const amzDate = (date: Date): string => date.toISOString().replace(/[:-]|\.\d{3}/g, '');

export type SignInput = {
  method: string;
  /** Exactly what the client sends as Host: the authority, with the port when it is not the scheme's default. */
  host: string;
  /** Unencoded path starting with `/`; each segment is encoded once (S3 does not double-encode). */
  path: string;
  /** Extra query parameters (unencoded). */
  query?: Readonly<Record<string, string>>;
  /** Extra headers to sign besides `host` (names are case-insensitive). */
  headers?: Readonly<Record<string, string>>;
  /** Hex SHA-256 of the body, or `UNSIGNED-PAYLOAD`. */
  payloadHash: string;
  region: string;
  service?: string;
  accessKeyId: string;
  secretAccessKey: string;
  date: Date;
  /** `query`: presigned URL (X-Amz-* parameters). `headers`: Authorization header. */
  mode: 'query' | 'headers';
  expiresSeconds?: number;
};
export type SignedRequest = {
  canonicalRequest: string; stringToSign: string; signature: string; signedHeaders: string; scope: string; amzDate: string;
  /** Final query string. In `query` mode it ends with `X-Amz-Signature`. */
  query: string;
  /** `headers` mode: the Authorization header value. */
  authorization?: string;
};

export function signRequest(input: SignInput): SignedRequest {
  const service = input.service ?? 's3';
  const stamp = amzDate(input.date), day = stamp.slice(0, 8);
  const scope = `${day}/${input.region}/${service}/aws4_request`;
  const headers = new Map<string, string>([['host', input.host]]);
  for (const [name, value] of Object.entries(input.headers ?? {})) headers.set(name.toLowerCase(), value);
  const names = [...headers.keys()].sort();
  const signedHeaders = names.join(';');
  const canonicalHeaders = names.map(name => `${name}:${(headers.get(name) as string).trim().replace(/\s+/g, ' ')}\n`).join('');
  const params: [string, string][] = Object.entries(input.query ?? {});
  if (input.mode === 'query') {
    params.push(['X-Amz-Algorithm', ALGORITHM], ['X-Amz-Credential', `${input.accessKeyId}/${scope}`], ['X-Amz-Date', stamp],
      ['X-Amz-Expires', String(input.expiresSeconds ?? 300)], ['X-Amz-SignedHeaders', signedHeaders]);
  }
  const pairs = params.map(([name, value]) => [uriEncode(name), uriEncode(value)] as const).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
  const canonicalQuery = pairs.map(([name, value]) => `${name}=${value}`).join('&');
  const canonicalRequest = [input.method.toUpperCase(), uriEncode(input.path, true), canonicalQuery, canonicalHeaders, signedHeaders, input.payloadHash].join('\n');
  const stringToSign = [ALGORITHM, stamp, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), service), 'aws4_request');
  const signature = hmac(signingKey, stringToSign).toString('hex');
  return {
    canonicalRequest, stringToSign, signature, signedHeaders, scope, amzDate: stamp,
    query: input.mode === 'query' ? `${canonicalQuery}&X-Amz-Signature=${signature}` : canonicalQuery,
    ...(input.mode === 'headers' ? { authorization: `${ALGORITHM} Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` } : {})
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------------------------------------------------
/** The per-client folder in the shared bucket: lowercase letters, digits and hyphens, 1-48 characters, starting with a letter or digit. */
export const MEDIA_PREFIX_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const isMediaPrefix = (value: unknown): value is string => typeof value === 'string' && MEDIA_PREFIX_PATTERN.test(value);
/** Every key `buildMediaKey` can produce: `{prefix}/assets/{kind}/{yyyy}/{mm}/{8 hex}-{slug}.{ext}`. */
export const MEDIA_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}\/assets\/(?:images|video|files)\/\d{4}\/(?:0[1-9]|1[0-2])\/[0-9a-f]{8}-[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]{2,5}$/;
export const isMediaKey = (key: unknown, prefix: string): key is string => typeof key === 'string' && key.length <= 300 && isMediaPrefix(prefix) && key.startsWith(`${prefix}/assets/`) && MEDIA_KEY_PATTERN.test(key);

export const MAX_SLUG_LENGTH = 60;
/** `[a-z0-9-]`, at most 60 characters, never empty. The visitor's extension and every path or unicode trick are dropped. */
export function slugifyFilename(name: unknown): string {
  const raw = typeof name === 'string' ? name.slice(0, 2000) : '';
  const base = (raw.split(/[\\/]/).pop() ?? '').replace(/\.[A-Za-z0-9]{1,5}$/, '');
  const slug = base.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_SLUG_LENGTH).replace(/-+$/, '');
  return slug || 'file';
}

export type BuildMediaKeyInput = {
  prefix: string;
  /** Optional; when given it must be the kind of `contentType`. */
  kind?: MediaKind;
  /** Already validated against the allowlist: the kind and the extension come from it. */
  contentType: AllowedMediaType;
  filename: unknown;
  now?: Date;
  /** Eight lowercase hex characters. */
  random?: () => string;
};
export const randomHex8 = (): string => randomBytes(4).toString('hex');

export function buildMediaKey(input: BuildMediaKeyInput): string {
  if (!isMediaPrefix(input.prefix)) throw new MediaStorageError('invalid', 'The media folder name is not valid.');
  if (!isAllowedMediaType(input.contentType)) throw new MediaStorageError('invalid', 'The media type is not allowed.');
  const kind = mediaKindFor(input.contentType);
  if (input.kind !== undefined && input.kind !== kind) throw new MediaStorageError('invalid', 'The media kind does not match the type.');
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new MediaStorageError('invalid', 'The time is not valid.');
  const random = (input.random ?? randomHex8)();
  if (!/^[0-9a-f]{8}$/.test(random)) throw new MediaStorageError('invalid', 'The random part is not valid.');
  const year = String(now.getUTCFullYear()).padStart(4, '0'), month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${input.prefix}/assets/${kind}/${year}/${month}/${random}-${slugifyFilename(input.filename)}.${mediaExtensionFor(input.contentType)}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Magic bytes and dimensions
// ---------------------------------------------------------------------------------------------------------------------
/** How much of an object is fetched to verify it: enough for the headers of every allowed image type, never the whole file. */
export const SNIFF_BYTES = 128 * 1024;
const MAX_DIMENSION = 100_000;

const ascii = (bytes: Uint8Array, start: number, end: number): string => { let out = ''; for (let i = start; i < end && i < bytes.length; i++) out += String.fromCharCode(bytes[i]); return out; };
const be16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const be32 = (b: Uint8Array, i: number) => ((b[i] * 0x1000000) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]));
const le16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const le24 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const le32 = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const AVIF_MAJORS = new Set(['avif', 'avis']);
const MP4_MAJORS = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9', 'mp41', 'mp42', 'mp71', 'avc1', 'dash', 'mmp4', 'M4V ', 'msdh', 'msix', 'cmfc']);

/** The allowed type the first bytes belong to, or null. Looks at magic bytes only; the declared type and the filename are never consulted. */
export function sniffMediaType(bytes: Uint8Array): AllowedMediaType | null {
  const n = bytes.length;
  if (n >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (n >= 8 && PNG_SIGNATURE.every((value, i) => bytes[i] === value)) return 'image/png';
  if (n >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) return 'image/gif';
  if (n >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
  if (n >= 12 && ascii(bytes, 4, 8) === 'ftyp') {
    const major = ascii(bytes, 8, 12);
    const boxEnd = Math.min(Math.max(be32(bytes, 0), 16), n, 64);
    const compatible: string[] = [];
    for (let i = 16; i + 4 <= boxEnd; i += 4) compatible.push(ascii(bytes, i, i + 4));
    if (AVIF_MAJORS.has(major) || ((major === 'mif1' || major === 'msf1') && compatible.some(brand => AVIF_MAJORS.has(brand)))) return 'image/avif';
    if (MP4_MAJORS.has(major)) return 'video/mp4';
    return null;
  }
  // Matroska and WebM share the EBML header; only the DocType tells them apart.
  if (n >= 8 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3 && ascii(bytes, 0, Math.min(n, 64)).includes('webm')) return 'video/webm';
  return null;
}

export type MediaDimensions = { width: number; height: number };
const valid = (width: number, height: number): MediaDimensions | null => Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1 && width <= MAX_DIMENSION && height <= MAX_DIMENSION ? { width, height } : null;

function jpegSize(b: Uint8Array): MediaDimensions | null {
  const n = b.length;
  let i = 2;
  while (i + 3 < n) {
    if (b[i] !== 0xff) return null;
    while (i < n && b[i] === 0xff) i++;
    const marker = b[i++];
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (marker === 0xd9 || marker === 0xda || i + 2 > n) return null;
    const length = be16(b, i);
    if (length < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return i + 7 <= n ? valid(be16(b, i + 5), be16(b, i + 3)) : null;
    i += length;
  }
  return null;
}
function webpSize(b: Uint8Array): MediaDimensions | null {
  const chunk = ascii(b, 12, 16);
  if (chunk === 'VP8X' && b.length >= 30) return valid(1 + le24(b, 24), 1 + le24(b, 27));
  if (chunk === 'VP8 ' && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return valid(le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff);
  if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f) { const bits = le32(b, 21); return valid((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1); }
  return null;
}
/** AVIF/HEIF store the picture size in `ispe` boxes under meta/iprp/ipco. A grid has small tile sizes plus the full size, so the largest wins. */
function avifSize(b: Uint8Array): MediaDimensions | null {
  let best: MediaDimensions | null = null;
  const walk = (start: number, end: number, depth: number) => {
    let i = start;
    while (depth < 5 && i + 8 <= end) {
      let size = be32(b, i), header = 8;
      const type = ascii(b, i + 4, i + 8);
      if (size === 1) { if (i + 16 > end || be32(b, i + 8) !== 0) return; size = be32(b, i + 12); header = 16; } else if (size === 0) size = end - i;
      if (size < header) return;
      const stop = Math.min(i + size, end), body = i + header;
      if (type === 'meta') walk(body + 4, stop, depth + 1);
      else if (type === 'iprp' || type === 'ipco') walk(body, stop, depth + 1);
      else if (type === 'ispe' && stop - body >= 12) {
        const size2 = valid(be32(b, body + 4), be32(b, body + 8));
        if (size2 && (!best || size2.width * size2.height > best.width * best.height)) best = size2;
      }
      if (i + size >= end) return;
      i += size;
    }
  };
  walk(0, b.length, 0);
  return best;
}

/** Pixel size read from the first bytes, or null when it is not there (video, or a header larger than the bytes given). */
export function readImageDimensions(bytes: Uint8Array, type: AllowedMediaType): MediaDimensions | null {
  try {
    switch (type) {
      case 'image/png': return bytes.length >= 24 && ascii(bytes, 12, 16) === 'IHDR' ? valid(be32(bytes, 16), be32(bytes, 20)) : null;
      case 'image/gif': return bytes.length >= 10 ? valid(le16(bytes, 6), le16(bytes, 8)) : null;
      case 'image/jpeg': return jpegSize(bytes);
      case 'image/webp': return webpSize(bytes);
      case 'image/avif': return avifSize(bytes);
      default: return null;
    }
  } catch { return null; }
}

export type MediaInspection = { contentType: AllowedMediaType; width?: number; height?: number };
export function inspectMedia(bytes: Uint8Array): MediaInspection | null {
  const contentType = sniffMediaType(bytes);
  if (!contentType) return null;
  const size = readImageDimensions(bytes, contentType);
  return { contentType, ...(size ?? {}) };
}

export type StoredObjectCheck = { ok: true; width?: number; height?: number } | { ok: false; reason: 'empty' | 'too_large' | 'size_mismatch' | 'type_mismatch' | 'content_mismatch' };
/** What the object that actually landed in the bucket must satisfy before it becomes an asset. */
export function checkStoredObject(input: { expectedType: AllowedMediaType; expectedSize: number; storedSize: number; storedType: string | undefined; firstBytes: Uint8Array; limits?: MediaLimits }): StoredObjectCheck {
  if (input.storedSize === 0) return { ok: false, reason: 'empty' };
  if (input.storedSize > maxBytesFor(input.expectedType, input.limits ?? DEFAULT_MEDIA_LIMITS)) return { ok: false, reason: 'too_large' };
  if (input.storedSize !== input.expectedSize) return { ok: false, reason: 'size_mismatch' };
  const stored = (input.storedType ?? '').split(';')[0].trim().toLowerCase();
  if (stored !== input.expectedType) return { ok: false, reason: 'type_mismatch' };
  const found = inspectMedia(input.firstBytes);
  if (!found || found.contentType !== input.expectedType) return { ok: false, reason: 'content_mismatch' };
  return { ok: true, ...(found.width !== undefined ? { width: found.width, height: found.height } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Endpoint, S3 client
// ---------------------------------------------------------------------------------------------------------------------
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;
export const isLoopbackHost = (hostname: string): boolean => LOOPBACK.test(hostname);

/**
 * `s3.us-east-005.backblazeb2.com` and `https://s3.us-east-005.backblazeb2.com/` both give `https://s3.us-east-005.backblazeb2.com`.
 * Only https is accepted unless `allowInsecure` (local tests against a loopback fake). No credentials, path, query or fragment.
 */
export function normalizeEndpoint(value: unknown, options: { allowInsecure?: boolean } = {}): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > 255 || /[\s\u0000-\u001f]/.test(text)) return null;
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`); } catch { return null; }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && options.allowInsecure === true)) return null;
  if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || !url.hostname) return null;
  return url.origin;
}

export type S3Config = { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string };
export type S3Deps = { fetch?: typeof fetch; now?: () => Date; timeoutMs?: number };
export type PresignedPut = { url: string; headers: Record<string, string>; expiresAt: string };
export type ObjectHead = { size: number; contentType: string; etag?: string };

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z0-9-]{2,32}$/;
const OBJECT_KEY = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,511}$/;
export const PRESIGN_EXPIRES_SECONDS = 300;

/** Defensive: no empty, dot or double-slash segments, so a key cannot climb out of its folder. */
export function assertObjectKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || !OBJECT_KEY.test(key) || key.split('/').some(part => part === '' || part === '.' || part === '..')) throw new MediaStorageError('invalid', 'The storage key is not valid.');
}

export function createS3Client(config: S3Config, deps: S3Deps = {}) {
  const origin = normalizeEndpoint(config.endpoint, { allowInsecure: true });
  if (!origin || !BUCKET.test(config.bucket) || !REGION.test(config.region) || typeof config.accessKeyId !== 'string' || !config.accessKeyId || config.accessKeyId.length > 256 || typeof config.secretAccessKey !== 'string' || !config.secretAccessKey || config.secretAccessKey.length > 512) {
    throw new MediaStorageError('invalid', 'The storage settings are not valid.');
  }
  const base = new URL(origin);
  const doFetch = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.timeoutMs ?? 20_000;
  const pathOf = (key: string) => `/${config.bucket}/${key}`;
  const common = { host: base.host, region: config.region, accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey };

  async function send(method: 'HEAD' | 'GET' | 'DELETE', key: string, range?: string): Promise<Response> {
    assertObjectKey(key);
    const date = now();
    const extra: Record<string, string> = { 'x-amz-content-sha256': EMPTY_PAYLOAD_SHA256, 'x-amz-date': amzDate(date), ...(range ? { range } : {}) };
    const signed = signRequest({ ...common, method, path: pathOf(key), headers: extra, payloadHash: EMPTY_PAYLOAD_SHA256, date, mode: 'headers' });
    let response: Response;
    try {
      response = await doFetch(`${origin}${uriEncode(pathOf(key), true)}`, { method, headers: { ...extra, authorization: signed.authorization as string }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch { throw new MediaStorageError('unavailable', 'Media storage could not be reached.'); }
    if (response.status === 404) { await response.body?.cancel().catch(() => undefined); throw new MediaStorageError('not_found', 'The stored file was not found.'); }
    if (response.status === 401 || response.status === 403) { await response.body?.cancel().catch(() => undefined); throw new MediaStorageError('denied', 'Media storage refused the request.'); }
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new MediaStorageError('unavailable', 'Media storage did not accept the request.'); }
    return response;
  }

  return {
    bucket: config.bucket,
    region: config.region,
    /** Path-style URL `{endpoint}/{bucket}/{key}` with query-string auth. Host, content-type and content-length are signed: the browser must send exactly those. */
    presignPut(input: { key: string; contentType: string; contentLength: number; expiresSeconds?: number }): PresignedPut {
      assertObjectKey(input.key);
      if (!/^[a-z]+\/[a-z0-9][a-z0-9.+-]*$/.test(input.contentType) || !Number.isSafeInteger(input.contentLength) || input.contentLength < 1) throw new MediaStorageError('invalid', 'The upload request is not valid.');
      const expires = input.expiresSeconds ?? PRESIGN_EXPIRES_SECONDS;
      if (!Number.isInteger(expires) || expires < 1 || expires > 3600) throw new MediaStorageError('invalid', 'The expiry is not valid.');
      const date = now();
      const signed = signRequest({ ...common, method: 'PUT', path: pathOf(input.key), headers: { 'content-type': input.contentType, 'content-length': String(input.contentLength) }, payloadHash: UNSIGNED_PAYLOAD, date, mode: 'query', expiresSeconds: expires });
      return { url: `${origin}${uriEncode(pathOf(input.key), true)}?${signed.query}`, headers: { 'content-type': input.contentType }, expiresAt: new Date(date.getTime() + expires * 1000).toISOString() };
    },
    async head(key: string): Promise<ObjectHead> {
      const response = await send('HEAD', key);
      const length = response.headers.get('content-length');
      const size = length === null || length.trim() === '' ? NaN : Number(length);
      if (!Number.isSafeInteger(size) || size < 0) throw new MediaStorageError('unavailable', 'Media storage returned an unexpected answer.');
      const etag = (response.headers.get('etag') ?? '').replace(/^W\//, '').replace(/"/g, '').slice(0, 128);
      return { size, contentType: response.headers.get('content-type') ?? '', ...(etag ? { etag } : {}) };
    },
    /** Bytes `start..end` (inclusive). A server that ignores Range and answers 200 is read only as far as needed. */
    async getRange(key: string, start: number, end: number): Promise<Uint8Array> {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start >= 4 * 1024 * 1024) throw new MediaStorageError('invalid', 'The range is not valid.');
      const response = await send('GET', key, `bytes=${start}-${end}`);
      const limit = end - start + 1;
      const reader = response.body?.getReader();
      if (!reader) return new Uint8Array(0);
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (total < limit) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          total += value.length;
        }
      } catch { throw new MediaStorageError('unavailable', 'Media storage could not be read.'); } finally { await reader.cancel().catch(() => undefined); }
      return Buffer.concat(chunks).subarray(0, limit);
    },
    /** Deleting a missing object succeeds. */
    async deleteObject(key: string): Promise<void> {
      try { await send('DELETE', key); } catch (error) { if (!(error instanceof MediaStorageError && error.code === 'not_found')) throw error; }
    }
  };
}
export type S3Client = ReturnType<typeof createS3Client>;
