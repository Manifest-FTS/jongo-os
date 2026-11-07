import { defaultCaches, type AuthCaches, type AuthDeps, type DiscoveryDocument, type JsonWebKeyLike, type JwksState } from './config.js';
import { authFail } from './errors.js';
import { request } from './http.js';

/** Only public Ed25519 keys with a `kid` are kept. Anything else (other key types, private material) is dropped. */
function parseKeys(json: unknown): Map<string, JsonWebKeyLike> {
  const keys = new Map<string, JsonWebKeyLike>();
  const list = (json as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(list)) return keys;
  for (const entry of list) {
    const jwk = entry as Record<string, unknown> | null;
    if (typeof jwk !== 'object' || jwk === null) continue;
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string' || typeof jwk.kid !== 'string' || jwk.kid === '' || 'd' in jwk) continue;
    if (jwk.use !== undefined && jwk.use !== 'sig') continue;
    if (jwk.alg !== undefined && jwk.alg !== 'EdDSA') continue;
    keys.set(jwk.kid, { kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid: jwk.kid });
  }
  return keys;
}

async function load(state: JwksState, doc: DiscoveryDocument, deps: AuthDeps, now: number): Promise<void> {
  if (!state.inflight) {
    state.inflight = (async () => {
      const { status, json } = await request(deps, doc.jwksUri, { method: 'GET', headers: { accept: 'application/json' } }, 'jwks_unavailable', { retry: true });
      const keys = status === 200 ? parseKeys(json) : new Map<string, JsonWebKeyLike>();
      if (keys.size === 0) return authFail('jwks_unavailable');
      state.keys = keys;
      state.fetchedAt = now;
    })().finally(() => { state.inflight = null; });
  }
  await state.inflight;
}

/**
 * Looks up a signing key by `kid` in the provider's JWKS.
 * - Cached for the TTL; the last good set keeps working if a refresh fails (an unknown key never does: no key, no login).
 * - An unknown `kid` triggers at most one refetch per cooldown window, so forged `kid` values cannot hammer the provider.
 */
export async function getSigningKey(doc: DiscoveryDocument, kid: string, deps: AuthDeps): Promise<JsonWebKeyLike> {
  const caches: AuthCaches = deps.caches ?? defaultCaches;
  const clock = deps.now ?? Date.now;
  let state = caches.jwks.get(doc.jwksUri);
  if (!state) { state = { keys: new Map(), fetchedAt: Number.NEGATIVE_INFINITY, lastUnknownKidRefetchAt: Number.NEGATIVE_INFINITY, inflight: null }; caches.jwks.set(doc.jwksUri, state); }

  let loadedNow = false;
  if (state.keys.size === 0 || clock() - state.fetchedAt >= caches.jwksTtlMs) {
    try { await load(state, doc, deps, clock()); loadedNow = true; } catch (error) { if (state.keys.size === 0) throw error; }
  }
  const known = state.keys.get(kid);
  if (known) return known;

  if (!loadedNow && clock() - state.lastUnknownKidRefetchAt >= caches.jwksCooldownMs) {
    state.lastUnknownKidRefetchAt = clock();
    try { await load(state, doc, deps, clock()); } catch { /* keep the last good set */ }
    const refreshed = state.keys.get(kid);
    if (refreshed) return refreshed;
  }
  return authFail('token_invalid');
}
