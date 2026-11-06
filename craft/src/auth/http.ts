import { authFail, type AuthErrorCode } from './errors.js';
import { DEFAULT_TIMEOUT_MS, type AuthDeps, type FetchLike } from './config.js';

/** Hard cap on any response body read from the provider. */
export const MAX_RESPONSE_BYTES = 64 * 1024;

export type HttpResult = { status: number; json: unknown };

async function readCapped(response: Response, max: number): Promise<string | null> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > max) return null;
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * One request to the provider: no redirect is ever followed, the whole exchange (headers and body) shares one timeout,
 * and the body is size-capped. Any transport problem, redirect or oversized body is reported as `failure` without detail.
 */
export async function request(deps: AuthDeps, url: string, init: RequestInit, failure: AuthErrorCode): Promise<HttpResult> {
  const doFetch: FetchLike = deps.fetch ?? ((input, options) => fetch(input, options));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs); });
  const work = (async (): Promise<HttpResult> => {
    const response = await doFetch(url, { ...init, redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: controller.signal });
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400) || response.status === 0) throw new Error('redirect');
    const text = await readCapped(response, MAX_RESPONSE_BYTES);
    if (text === null) throw new Error('too large');
    let json: unknown = null;
    if (text !== '') { try { json = JSON.parse(text); } catch { json = null; } }
    return { status: response.status, json };
  })();
  work.catch(() => undefined);
  try {
    return await Promise.race([work, deadline]);
  } catch {
    return authFail(failure);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
