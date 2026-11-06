/**
 * @jongo/craft/auth: server-only relying-party helpers for "Sign in with Jongo" (OIDC authorization code + PKCE, EdDSA ID tokens).
 * Needs Node crypto and, for ID token verification, the optional peer `jose`. Never import this from client code: a test
 * enforces that no client entry reaches it. Nothing here logs; errors carry fixed messages, never tokens or secrets.
 */
export { CraftAuthError, type AuthErrorCode } from './errors.js';
export { CRAFT_ROLES, isCraftRole, mapRoleToActions, type CraftRole } from './roles.js';
export {
  createAuthCaches, defaultCaches, DEFAULT_CLOCK_SKEW_SECONDS, DEFAULT_TIMEOUT_MS, MIN_SECRET_LENGTH, TRANSACTION_TTL_SECONDS,
  type AuthCaches, type AuthDeps, type ClientAuthMethod, type DiscoveryDocument, type FetchLike, type RelyingPartyConfig
} from './config.js';
export { discover } from './discovery.js';
export { createLoginTransaction, openTransaction, sealTransaction, type LoginTransaction, type TransactionPayload } from './transaction.js';
export { completeLogin, type CallbackQuery, type VerifiedIdentity } from './login.js';
