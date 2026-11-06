import { authFail } from './errors.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type ClientAuthMethod = 'client_secret_basic' | 'client_secret_post';

export type RelyingPartyConfig = {
  /** Origin of the Jongo identity provider, exactly as it appears in the ID token `iss` (no trailing slash). */
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** The Craft dataset name this site serves; the ID token `craft.dataset` must equal it. */
  dataset: string;
  /** Site secret (at least 32 characters). Protects the login transaction cookie; never sent anywhere. */
  secret: string;
  clientAuth?: ClientAuthMethod;
  scope?: string;
};

export type AuthDeps = {
  fetch?: FetchLike;
  now?: () => number;
  random?: (bytes: number) => Uint8Array;
  timeoutMs?: number;
  caches?: AuthCaches;
  clockSkewSeconds?: number;
};

export type DiscoveryDocument = { issuer: string; authorizationEndpoint: string; tokenEndpoint: string; jwksUri: string };
export type AuthCaches = {
  discovery: Map<string, { at: number; doc: DiscoveryDocument }>;
  jwks: Map<string, JwksState>;
  discoveryTtlMs: number;
  jwksTtlMs: number;
  jwksCooldownMs: number;
};
export type JwksState = { keys: Map<string, JsonWebKeyLike>; fetchedAt: number; lastUnknownKidRefetchAt: number; inflight: Promise<void> | null };
export type JsonWebKeyLike = { kty: string; crv: string; x: string; kid: string; [key: string]: unknown };

export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_CLOCK_SKEW_SECONDS = 60;
export const TRANSACTION_TTL_SECONDS = 600;
export const MIN_SECRET_LENGTH = 32;

export function createAuthCaches(options: Partial<Pick<AuthCaches, 'discoveryTtlMs' | 'jwksTtlMs' | 'jwksCooldownMs'>> = {}): AuthCaches {
  return { discovery: new Map(), jwks: new Map(), discoveryTtlMs: 10 * 60_000, jwksTtlMs: 10 * 60_000, jwksCooldownMs: 60_000, ...options };
}
/** Shared by every call that does not pass its own caches (one per server process). */
export const defaultCaches: AuthCaches = createAuthCaches();

export const isLoopbackHost = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1' || /^127(\.\d{1,3}){3}$/.test(hostname);

/** Returns the URL when it is https (or http on a loopback host, for local testing) without credentials or a fragment. */
export function parseSecureUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password || url.hash) return null;
  if (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname))) return url;
  return null;
}

/** Throws invalid_config unless the issuer is a bare origin; returns it unchanged. */
export function assertIssuer(issuer: unknown): string {
  const url = parseSecureUrl(issuer);
  if (!url || url.search || (url.pathname !== '/' && url.pathname !== '') || url.origin !== issuer) return authFail('invalid_config');
  return issuer as string;
}

export function assertConfig(config: RelyingPartyConfig): void {
  assertIssuer(config.issuer);
  const redirect = parseSecureUrl(config.redirectUri);
  if (!redirect || redirect.search) authFail('invalid_config');
  if (!/^[A-Za-z0-9._~-]{1,128}$/.test(config.clientId)) authFail('invalid_config');
  if (typeof config.clientSecret !== 'string' || config.clientSecret.length === 0 || config.clientSecret.length > 256) authFail('invalid_config');
  if (typeof config.secret !== 'string' || config.secret.length < MIN_SECRET_LENGTH) authFail('invalid_config');
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(config.dataset)) authFail('invalid_config');
}
