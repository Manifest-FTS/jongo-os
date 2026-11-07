/** Media contract shared by the Studio UI and the host's server code. Pure: no React, no Node APIs, no network. */
import { FILE_ASSET_TYPE, IMAGE_ASSET_TYPE, type TypeDefinition } from './schema.js';

export type MediaKind = 'images' | 'video' | 'files';

/**
 * The only types that can be uploaded. The extension comes from here, never from the visitor's filename.
 * SVG is refused on purpose: it is a script-capable document, so a "picture" served from the public bucket could run
 * script in the viewer's browser (stored XSS), and it cannot be reliably told apart from XML by its first bytes.
 * Everything else (HTML, PDF, Office files, archives, executables, audio) is refused because nothing in the schema uses it.
 */
export const MEDIA_TYPES = {
  'image/jpeg': { kind: 'images', ext: 'jpg' },
  'image/png': { kind: 'images', ext: 'png' },
  'image/webp': { kind: 'images', ext: 'webp' },
  'image/avif': { kind: 'images', ext: 'avif' },
  'image/gif': { kind: 'images', ext: 'gif' },
  'video/mp4': { kind: 'video', ext: 'mp4' },
  'video/webm': { kind: 'video', ext: 'webm' }
} as const satisfies Record<string, { kind: MediaKind; ext: string }>;
export type AllowedMediaType = keyof typeof MEDIA_TYPES;
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'] as const satisfies readonly AllowedMediaType[];
export const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/webm'] as const satisfies readonly AllowedMediaType[];

export const isAllowedMediaType = (value: unknown): value is AllowedMediaType => typeof value === 'string' && Object.hasOwn(MEDIA_TYPES, value);
export const mediaKindFor = (contentType: AllowedMediaType): MediaKind => MEDIA_TYPES[contentType].kind;
export const mediaExtensionFor = (contentType: AllowedMediaType): string => MEDIA_TYPES[contentType].ext;
export const assetTypeFor = (contentType: AllowedMediaType): typeof IMAGE_ASSET_TYPE | typeof FILE_ASSET_TYPE => MEDIA_TYPES[contentType].kind === 'images' ? IMAGE_ASSET_TYPE : FILE_ASSET_TYPE;

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 250 * 1024 * 1024;
export type MediaLimits = { maxImageBytes: number; maxVideoBytes: number };
export const DEFAULT_MEDIA_LIMITS: Readonly<MediaLimits> = { maxImageBytes: MAX_IMAGE_BYTES, maxVideoBytes: MAX_VIDEO_BYTES };

/** Hosts may change the limits; anything that is not a positive safe integer falls back to the default. */
export function mediaLimits(overrides: Partial<MediaLimits> = {}): MediaLimits {
  const pick = (value: unknown, fallback: number) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
  return { maxImageBytes: pick(overrides.maxImageBytes, MAX_IMAGE_BYTES), maxVideoBytes: pick(overrides.maxVideoBytes, MAX_VIDEO_BYTES) };
}
export const maxBytesFor = (contentType: AllowedMediaType, limits: MediaLimits = DEFAULT_MEDIA_LIMITS): number => MEDIA_TYPES[contentType].kind === 'video' ? limits.maxVideoBytes : limits.maxImageBytes;

export function describeBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb >= 100 || Number.isInteger(mb) ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

/** What the editor can be told when an upload does not go through. */
export type UploadErrorCode = 'type_not_allowed' | 'too_large' | 'empty' | 'invalid' | 'upload_failed' | 'verify_failed' | 'rate_limited' | 'unavailable' | 'denied' | 'cancelled';
export const UPLOAD_MESSAGES: Readonly<Record<UploadErrorCode, string>> = {
  type_not_allowed: 'This file type is not allowed. Use JPEG, PNG, WebP, AVIF or GIF images.',
  too_large: 'This file is larger than the upload limit.',
  empty: 'This file is empty.',
  invalid: 'The upload request was not accepted.',
  upload_failed: 'The upload did not finish. Check your connection and try again.',
  verify_failed: 'The file was uploaded but could not be verified, so it was not added. Check that it is a real image of an allowed type and try again.',
  rate_limited: 'Too many uploads in a short time. Wait a moment and try again.',
  unavailable: 'Uploading is not available right now.',
  denied: 'Your session ended. Sign in to continue.',
  cancelled: 'The upload was cancelled.'
};
export function tooLargeMessage(contentType: AllowedMediaType, limits: MediaLimits = DEFAULT_MEDIA_LIMITS): string {
  return `This file is larger than the ${describeBytes(maxBytesFor(contentType, limits))} limit for ${MEDIA_TYPES[contentType].kind === 'video' ? 'videos' : 'images'}.`;
}

export type UploadCheck =
  | { ok: true; contentType: AllowedMediaType; kind: MediaKind; ext: string }
  | { ok: false; code: 'type_not_allowed' | 'too_large' | 'empty' | 'invalid'; message: string };

/** Type and size only. The server repeats this and then looks at the file's own bytes. */
export function checkUpload(input: { contentType: unknown; size: unknown }, limits: MediaLimits = DEFAULT_MEDIA_LIMITS): UploadCheck {
  const { contentType, size } = input;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return { ok: false, code: 'invalid', message: UPLOAD_MESSAGES.invalid };
  if (!isAllowedMediaType(contentType)) return { ok: false, code: 'type_not_allowed', message: UPLOAD_MESSAGES.type_not_allowed };
  if (size === 0) return { ok: false, code: 'empty', message: UPLOAD_MESSAGES.empty };
  if (size > maxBytesFor(contentType, limits)) return { ok: false, code: 'too_large', message: tooLargeMessage(contentType, limits) };
  return { ok: true, contentType, kind: MEDIA_TYPES[contentType].kind, ext: MEDIA_TYPES[contentType].ext };
}

/** A label for the editor, not a path: directories, control and bidirectional-override characters removed, at most 120 characters. */
export function displayFilename(name: unknown): string {
  const text = typeof name === 'string' ? name : '';
  const base = text.split(/[\\/]/).pop() ?? '';
  const clean = base.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(clean).slice(0, 120).join('').trim();
  return chars || 'upload';
}

// ---- asset documents ----
/** An uploaded asset as the Studio sees it: a document of `sanity.imageAsset` (images) or `sanity.fileAsset` (everything else). */
export type StudioAssetDocument = {
  _id: string; _type: typeof IMAGE_ASSET_TYPE | typeof FILE_ASSET_TYPE; url: string; mimeType?: string; size?: number; width?: number; height?: number;
  originalFilename?: string; createdAt?: string; uploadedBy?: string;
} & { [key: string]: unknown };

/** Registered by the host's server service for the documents it creates itself. Never offered as editable content. */
const assetFields = [
  { name: 'url', type: 'url', required: true, maxLength: 1024 },
  { name: 'mimeType', type: 'string', required: true, maxLength: 100 },
  { name: 'size', type: 'number', required: true, integer: true, min: 1 },
  { name: 'width', type: 'number', integer: true, min: 1, max: 100000 },
  { name: 'height', type: 'number', integer: true, min: 1, max: 100000 },
  { name: 'originalFilename', type: 'string', maxLength: 200 },
  { name: 'storageKey', type: 'string', required: true, maxLength: 512 },
  { name: 'etag', type: 'string', maxLength: 128 },
  { name: 'createdAt', type: 'datetime', required: true },
  { name: 'uploadedBy', type: 'string', maxLength: 80 }
] as const;
export const ASSET_TYPE_DEFINITIONS: readonly TypeDefinition[] = [
  { name: IMAGE_ASSET_TYPE, type: 'document', title: 'Image asset', schemaVersion: 1, preview: { title: 'originalFilename' }, fields: assetFields },
  { name: FILE_ASSET_TYPE, type: 'document', title: 'File asset', schemaVersion: 1, preview: { title: 'originalFilename' }, fields: assetFields }
];
export const isAssetType = (type: unknown): boolean => type === IMAGE_ASSET_TYPE || type === FILE_ASSET_TYPE;
