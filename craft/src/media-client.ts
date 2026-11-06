/** Browser side of an upload: validate, ask the host for a ticket, PUT the file straight to storage, ask the host to verify it. No React. */
import { DEFAULT_MEDIA_LIMITS, UPLOAD_MESSAGES, checkUpload, type MediaLimits, type StudioAssetDocument } from './media-contract.js';
import { settleUpload, type StudioStore, type UploadFailure, type UploadResult, type UploadTicket } from './studio-store.js';

export type UploadHandlers = {
  /** Fraction 0..1, or null when the browser cannot tell how far it got (indeterminate). */
  onProgress?: (fraction: number | null) => void;
  signal?: AbortSignal;
};
export type PutFile = (ticket: UploadTicket, file: Blob, handlers: UploadHandlers) => Promise<{ ok: true } | { ok: false; cancelled?: boolean }>;
export type UploadSource = Blob & { name: string };

const fail = (code: UploadFailure['code']): UploadFailure => ({ ok: false, code, message: UPLOAD_MESSAGES[code] });

/** XHR rather than fetch because only XHR reports upload progress. Sends no cookies: the signed URL is the only credential. */
export const xhrPut: PutFile = (ticket, file, { onProgress, signal } = {}) => new Promise(resolve => {
  if (signal?.aborted) { resolve({ ok: false, cancelled: true }); return; }
  const xhr = new XMLHttpRequest();
  xhr.open('PUT', ticket.uploadUrl);
  for (const [name, value] of Object.entries(ticket.headers)) xhr.setRequestHeader(name, value);
  xhr.upload.onprogress = event => onProgress?.(event.lengthComputable && event.total > 0 ? event.loaded / event.total : null);
  xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300 ? { ok: true } : { ok: false });
  xhr.onerror = () => resolve({ ok: false });
  xhr.ontimeout = () => resolve({ ok: false });
  xhr.onabort = () => resolve({ ok: false, cancelled: true });
  signal?.addEventListener('abort', () => xhr.abort(), { once: true });
  xhr.send(file);
});

/** Never rejects. Type and size are checked before any network call; every other failure is a typed code. */
export async function uploadAsset(
  store: Pick<StudioStore, 'requestUpload' | 'completeUpload'>, file: UploadSource, handlers: UploadHandlers = {}, options: { put?: PutFile; limits?: MediaLimits } = {}
): Promise<UploadResult<{ asset: StudioAssetDocument }>> {
  const { requestUpload, completeUpload } = store;
  if (!requestUpload || !completeUpload) return fail('unavailable');
  const checked = checkUpload({ contentType: file.type, size: file.size }, options.limits ?? DEFAULT_MEDIA_LIMITS);
  if (!checked.ok) return { ok: false, code: checked.code, message: checked.message };
  if (handlers.signal?.aborted) return fail('cancelled');
  const ticket = await settleUpload(() => requestUpload.call(store, { filename: file.name, contentType: checked.contentType, size: file.size }));
  if (!ticket.ok) return ticket;
  if (handlers.signal?.aborted) return fail('cancelled');
  let sent: Awaited<ReturnType<PutFile>>;
  try { sent = await (options.put ?? xhrPut)(ticket, file, handlers); } catch { sent = { ok: false }; }
  if (!sent.ok) return fail(sent.cancelled ? 'cancelled' : 'upload_failed');
  handlers.onProgress?.(1);
  return settleUpload(() => completeUpload.call(store, { key: ticket.key, token: ticket.token, contentType: ticket.contentType, size: ticket.size, filename: file.name }));
}
