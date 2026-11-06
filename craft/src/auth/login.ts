import { assertConfig, DEFAULT_CLOCK_SKEW_SECONDS, type AuthDeps, type RelyingPartyConfig } from './config.js';
import { discover } from './discovery.js';
import { authFail, CraftAuthError } from './errors.js';
import { request } from './http.js';
import { getSigningKey } from './jwks.js';
import { isCraftRole, type CraftRole } from './roles.js';
import { constantTimeEqual, openTransaction } from './transaction.js';

export type VerifiedIdentity = {
  sub: string;
  email: string;
  emailVerified: true;
  name: string | null;
  dataset: string;
  role: CraftRole;
  via: string;
  siteId: string | null;
  /** Epoch seconds when Jongo verified the person's session, or null when the token does not say. */
  authTime: number | null;
};

export type CallbackQuery = URLSearchParams | Record<string, string | string[] | undefined>;

/** Jongo issues ID tokens for five minutes; an older `iat` is refused (plus clock skew). */
const ID_TOKEN_MAX_AGE_SECONDS = 300;
const MAX_PARAM = 2048;
const SUBJECT = /^[A-Za-z0-9._:-]{1,100}$/;
const VIA = /^[a-z][a-z_]{0,31}$/;
const FORBIDDEN_HEADERS = ['jku', 'x5u', 'x5c', 'jwk'];

function single(query: CallbackQuery, name: string): string | undefined {
  if (query instanceof URLSearchParams) {
    const all = query.getAll(name);
    if (all.length > 1) return authFail('invalid_callback');
    return all[0];
  }
  const value = query[name];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : authFail('invalid_callback');
  return value;
}

function formEncode(value: string): string { return encodeURIComponent(value).replace(/%20/g, '+'); }

async function exchangeCode(config: RelyingPartyConfig, tokenEndpoint: string, code: string, verifier: string, deps: AuthDeps): Promise<string> {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: config.redirectUri, code_verifier: verifier });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (config.clientAuth === 'client_secret_post') {
    body.set('client_id', config.clientId);
    body.set('client_secret', config.clientSecret);
  } else {
    headers.authorization = `Basic ${Buffer.from(`${formEncode(config.clientId)}:${formEncode(config.clientSecret)}`, 'utf8').toString('base64')}`;
  }
  const { status, json } = await request(deps, tokenEndpoint, { method: 'POST', headers, body: body.toString() }, 'token_exchange_failed');
  const idToken = (json as { id_token?: unknown } | null)?.id_token;
  if (status !== 200 || typeof idToken !== 'string' || idToken.length === 0 || idToken.length > 8192) return authFail('token_exchange_failed');
  return idToken;
}

/** Verifies the ID token and returns its claims. Everything must pass; the first failure throws a safe, fixed error. */
async function verifyIdToken(config: RelyingPartyConfig, idToken: string, expectedNonce: string, deps: AuthDeps, doc: Awaited<ReturnType<typeof discover>>): Promise<VerifiedIdentity> {
  let jose: typeof import('jose');
  try { jose = await import('jose'); } catch { return authFail('invalid_config'); }
  const skew = deps.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  const nowMs = (deps.now ?? Date.now)();

  let header: ReturnType<typeof jose.decodeProtectedHeader>;
  try { header = jose.decodeProtectedHeader(idToken); } catch { return authFail('token_invalid'); }
  if (header.alg !== 'EdDSA' || typeof header.kid !== 'string' || header.kid === '' || FORBIDDEN_HEADERS.some(name => name in header) || 'crit' in header) return authFail('token_invalid');

  const jwk = await getSigningKey(doc, header.kid, deps);
  let payload: Awaited<ReturnType<typeof jose.jwtVerify>>['payload'];
  try {
    const key = await jose.importJWK(jwk as never, 'EdDSA');
    ({ payload } = await jose.jwtVerify(idToken, key, {
      algorithms: ['EdDSA'], issuer: config.issuer, audience: config.clientId, currentDate: new Date(nowMs), clockTolerance: skew,
      requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat', 'nonce']
    }));
  } catch (error) {
    if (error instanceof CraftAuthError) throw error;
    return authFail('token_invalid');
  }

  const nowSeconds = Math.floor(nowMs / 1000);
  const { iat, aud, azp, nonce, sub, email, name, auth_time: authTime, email_verified: emailVerified } = payload as Record<string, unknown>;
  if (typeof iat !== 'number' || iat > nowSeconds + skew || iat < nowSeconds - ID_TOKEN_MAX_AGE_SECONDS - skew) return authFail('token_invalid');
  if (!(aud === config.clientId || (Array.isArray(aud) && aud.length === 1 && aud[0] === config.clientId))) return authFail('token_invalid');
  if (azp !== undefined && azp !== config.clientId) return authFail('token_invalid');
  if (typeof nonce !== 'string' || !constantTimeEqual(nonce, expectedNonce)) return authFail('token_invalid');
  if (typeof sub !== 'string' || !SUBJECT.test(sub)) return authFail('claims_invalid');
  if (emailVerified !== true) return authFail('email_unverified');
  if (typeof email !== 'string' || email.length === 0 || email.length > 254 || /[\u0000-\u001f\u007f]/.test(email)) return authFail('claims_invalid');
  if (name !== undefined && (typeof name !== 'string' || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name))) return authFail('claims_invalid');
  if (authTime !== undefined && !Number.isSafeInteger(authTime)) return authFail('claims_invalid');

  const craft = (payload as Record<string, unknown>).craft as Record<string, unknown> | undefined;
  if (typeof craft !== 'object' || craft === null || Array.isArray(craft)) return authFail('claims_invalid');
  if (typeof craft.dataset !== 'string' || craft.dataset !== config.dataset) return authFail('dataset_mismatch');
  if (!isCraftRole(craft.role)) return authFail('role_unknown');
  const via = craft.via === undefined ? 'site_grant' : craft.via;
  if (typeof via !== 'string' || !VIA.test(via)) return authFail('claims_invalid');
  const siteId = typeof craft.siteId === 'string' && craft.siteId.length <= 100 ? craft.siteId : null;

  return {
    sub, email, emailVerified: true, name: typeof name === 'string' && name.trim() !== '' ? name.trim() : null,
    dataset: craft.dataset, role: craft.role, via, siteId, authTime: typeof authTime === 'number' ? authTime : null
  };
}

/**
 * Step 2 of the login (the provider redirected back). `transactionCookie` is the raw cookie value; the caller deletes the cookie
 * before calling so a replayed callback has nothing to consume. Throws CraftAuthError with a fixed, token-free message on any failure.
 */
export async function completeLogin({ transactionCookie, query, config, ...deps }: { transactionCookie: unknown; query: CallbackQuery; config: RelyingPartyConfig } & AuthDeps): Promise<VerifiedIdentity> {
  assertConfig(config);
  const providerError = single(query, 'error');
  if (providerError !== undefined) return authFail('provider_error');

  const tx = openTransaction(config.secret, transactionCookie);
  if (!tx) return authFail('transaction_invalid');
  if (Math.floor((deps.now ?? Date.now)() / 1000) >= tx.exp) return authFail('transaction_expired');
  if (tx.iss !== config.issuer || tx.cid !== config.clientId) return authFail('transaction_invalid');

  const state = single(query, 'state');
  if (typeof state !== 'string' || state.length === 0 || state.length > MAX_PARAM || !constantTimeEqual(state, tx.state)) return authFail('state_mismatch');
  const iss = single(query, 'iss');
  if (iss !== undefined && iss !== config.issuer) return authFail('issuer_mismatch');
  const code = single(query, 'code');
  if (typeof code !== 'string' || code.length === 0 || code.length > MAX_PARAM) return authFail('invalid_callback');

  const doc = await discover(config.issuer, { ...deps, clientAuth: config.clientAuth });
  const idToken = await exchangeCode(config, doc.tokenEndpoint, code, tx.verifier, deps);
  return verifyIdToken(config, idToken, tx.nonce, deps, doc);
}
