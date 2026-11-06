import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { assertConfig, TRANSACTION_TTL_SECONDS, type AuthDeps, type RelyingPartyConfig } from './config.js';
import { discover } from './discovery.js';

export type LoginTransaction = { authorizeUrl: string; cookieValue: string; maxAgeSeconds: number };
export type TransactionPayload = { v: 1; state: string; nonce: string; verifier: string; iss: string; cid: string; exp: number };

const VERSION = 'v1';
const AAD = Buffer.from('jongo-craft-oidc-transaction-v1');
const MAX_COOKIE_LENGTH = 1024;
const DEFAULT_SCOPE = 'openid email profile';

const randomToken = (deps: AuthDeps, bytes: number): string => Buffer.from((deps.random ?? randomBytes)(bytes)).toString('base64url');
const key = (secret: string): Buffer => Buffer.from(hkdfSync('sha256', secret, 'jongo-craft', 'oidc-transaction-cookie', 32));

/** AES-256-GCM under a key derived from the site secret: the PKCE verifier is neither readable nor alterable in the browser. */
export function sealTransaction(secret: string, payload: TransactionPayload, deps: AuthDeps = {}): string {
  const iv = Buffer.from((deps.random ?? randomBytes)(12));
  const cipher = createCipheriv('aes-256-gcm', key(secret), iv);
  cipher.setAAD(AAD);
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), body.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}

/** Returns the payload of an untampered cookie, or null. Expiry is judged by the caller. */
export function openTransaction(secret: string, value: unknown): TransactionPayload | null {
  if (typeof secret !== 'string' || secret === '' || typeof value !== 'string' || value.length > MAX_COOKIE_LENGTH) return null;
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const iv = Buffer.from(parts[1], 'base64url'), body = Buffer.from(parts[2], 'base64url'), tag = Buffer.from(parts[3], 'base64url');
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv('aes-256-gcm', key(secret), iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const parsed = JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')) as Partial<TransactionPayload>;
    if (parsed.v !== 1 || ![parsed.state, parsed.nonce, parsed.verifier, parsed.iss, parsed.cid].every(item => typeof item === 'string' && item !== '') || !Number.isSafeInteger(parsed.exp)) return null;
    return parsed as TransactionPayload;
  } catch { return null; }
}

/** Equal-length digests compared in constant time, so neither content nor length leaks through timing. */
export function constantTimeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a, 'utf8').digest(), createHash('sha256').update(b, 'utf8').digest());
}

/**
 * Step 1 of the login: new `state`, `nonce` and PKCE verifier, sealed in a cookie value valid for 10 minutes, and the provider's
 * authorize URL. The caller sets the cookie (HttpOnly, Secure, SameSite=Lax, narrow Path) and redirects the browser.
 */
export async function createLoginTransaction({ config, ...deps }: { config: RelyingPartyConfig } & AuthDeps): Promise<LoginTransaction> {
  assertConfig(config);
  const doc = await discover(config.issuer, { ...deps, clientAuth: config.clientAuth });
  const verifier = randomToken(deps, 32);
  const state = randomToken(deps, 16);
  const nonce = randomToken(deps, 16);
  const nowSeconds = Math.floor((deps.now ?? Date.now)() / 1000);
  const url = new URL(doc.authorizationEndpoint);
  url.search = '';
  for (const [name, value] of Object.entries({
    response_type: 'code', client_id: config.clientId, redirect_uri: config.redirectUri, scope: config.scope ?? DEFAULT_SCOPE,
    state, nonce, code_challenge: createHash('sha256').update(verifier, 'ascii').digest('base64url'), code_challenge_method: 'S256'
  })) url.searchParams.set(name, value);
  const cookieValue = sealTransaction(config.secret, { v: 1, state, nonce, verifier, iss: config.issuer, cid: config.clientId, exp: nowSeconds + TRANSACTION_TTL_SECONDS }, deps);
  return { authorizeUrl: url.href, cookieValue, maxAgeSeconds: TRANSACTION_TTL_SECONDS };
}
