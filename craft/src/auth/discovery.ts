import { assertIssuer, defaultCaches, parseSecureUrl, type AuthDeps, type ClientAuthMethod, type DiscoveryDocument } from './config.js';
import { authFail, CraftAuthError } from './errors.js';
import { request, type HttpResult } from './http.js';

const list = (value: unknown): string[] | null => Array.isArray(value) && value.every(item => typeof item === 'string') ? value as string[] : null;

function sameOriginEndpoint(value: unknown, origin: string): string {
  const url = parseSecureUrl(value);
  if (!url || url.origin !== origin) return authFail('discovery_invalid');
  return url.href;
}

/**
 * Fetches and validates the provider's discovery document (cached per issuer). The document must name the configured issuer, keep every
 * endpoint on the issuer's own origin, and advertise the authorization code flow with S256 PKCE and EdDSA ID tokens.
 */
export async function discover(issuer: string, deps: AuthDeps & { clientAuth?: ClientAuthMethod } = {}): Promise<DiscoveryDocument> {
  assertIssuer(issuer);
  const caches = deps.caches ?? defaultCaches;
  const now = (deps.now ?? Date.now)();
  const cached = caches.discovery.get(issuer);
  if (cached && now - cached.at < caches.discoveryTtlMs) return cached.doc;

  let reply: HttpResult;
  try {
    reply = await request(deps, `${issuer}/.well-known/openid-configuration`, { method: 'GET', headers: { accept: 'application/json' } }, 'discovery_failed', { retry: true });
    if (reply.status !== 200) return authFail('discovery_failed');
  } catch (error) {
    // A document that passed every check before keeps serving while the provider is briefly unreachable; a document that fails the checks is never replaced by it.
    if (cached && error instanceof CraftAuthError && error.code === 'discovery_failed') return cached.doc;
    throw error;
  }
  const { json } = reply;
  const raw = json as Record<string, unknown> | null;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return authFail('discovery_invalid');
  if (raw.issuer !== issuer) return authFail('discovery_invalid');

  const origin = new URL(issuer).origin;
  const responseTypes = list(raw.response_types_supported);
  const challenge = list(raw.code_challenge_methods_supported);
  const algs = list(raw.id_token_signing_alg_values_supported);
  if (!responseTypes?.includes('code') || !challenge?.includes('S256') || !algs?.includes('EdDSA')) return authFail('discovery_invalid');
  if (raw.grant_types_supported !== undefined && !list(raw.grant_types_supported)?.includes('authorization_code')) return authFail('discovery_invalid');
  const methods = raw.token_endpoint_auth_methods_supported === undefined ? ['client_secret_basic'] : list(raw.token_endpoint_auth_methods_supported);
  if (!methods?.includes(deps.clientAuth ?? 'client_secret_basic')) return authFail('discovery_invalid');

  const doc: DiscoveryDocument = {
    issuer,
    authorizationEndpoint: sameOriginEndpoint(raw.authorization_endpoint, origin),
    tokenEndpoint: sameOriginEndpoint(raw.token_endpoint, origin),
    jwksUri: sameOriginEndpoint(raw.jwks_uri, origin)
  };
  caches.discovery.set(issuer, { at: now, doc });
  return doc;
}
