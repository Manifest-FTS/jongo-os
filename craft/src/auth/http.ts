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

class Refused extends Error {}
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/** Short wait before the single repeat of an idempotent read. */
export const RETRY_DELAY_MS = 200;

async function attempt(deps: AuthDeps, url: string, init: RequestInit): Promise<HttpResult> {
  const doFetch: FetchLike = deps.fetch ?? ((input, options) => fetch(input, options));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs); });
  const work = (async (): Promise<HttpResult> => {
    const response = await doFetch(url, { ...init, redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: controller.signal });
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400) || response.status === 0) throw new Refused('redirect');
    const text = await readCapped(response, MAX_RESPONSE_BYTES);
    if (text === null) throw new Refused('too large');
    let json: unknown = null;
    if (text !== '') { try { json = JSON.parse(text); } catch { json = null; } }
    return { status: response.status, json };
  })();
  work.catch(() => undefined);
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * One request to the provider: no redirect is ever followed, the whole exchange (headers and body) shares one timeout,
 * and the body is size-capped. Any transport problem, redirect or oversized body is reported as `failure` without detail.
 * `retry: true` (reads only: discovery and the key set, never the one-time code exchange) repeats the request ONCE after a short pause when the
 * connection failed, timed out or the provider answered 5xx, so a single hiccup does not end a sign-in. A redirect or an oversized body is never repeated.
 */
export async function request(deps: AuthDeps, url: string, init: RequestInit, failure: AuthErrorCode, options: { retry?: boolean } = {}): Promise<HttpResult> {
  const repeat = options.retry === true && (init.method === undefined || init.method === 'GET');
  for (let tries = 1; ; tries++) {
    let result: HttpResult;
    try {
      result = await attempt(deps, url, init);
    } catch (error) {
      if (repeat && tries === 1 && !(error instanceof Refused)) { await pause(RETRY_DELAY_MS); continue; }
      return authFail(failure);
    }
    if (repeat && tries === 1 && result.status >= 500) { await pause(RETRY_DELAY_MS); continue; }
    return result;
  }
}
