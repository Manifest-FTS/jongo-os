/** Typed errors with fixed, safe messages. They never carry tokens, codes, secrets, URLs or provider text. */
export type AuthErrorCode =
  | 'invalid_config' | 'discovery_failed' | 'discovery_invalid'
  | 'transaction_invalid' | 'transaction_expired' | 'state_mismatch' | 'provider_error' | 'issuer_mismatch' | 'invalid_callback'
  | 'token_exchange_failed' | 'jwks_unavailable' | 'token_invalid' | 'claims_invalid'
  | 'email_unverified' | 'dataset_mismatch' | 'role_unknown';

/** Where in the sign-in an error arose. `verify` covers the checks of the sign-in attempt and of the provider's response, including the ID token. */
export type AuthStep = 'discover' | 'token' | 'jwks' | 'verify';
const STEPS: Record<AuthErrorCode, AuthStep> = {
  invalid_config: 'verify', transaction_invalid: 'verify', transaction_expired: 'verify', state_mismatch: 'verify', provider_error: 'verify', issuer_mismatch: 'verify', invalid_callback: 'verify',
  discovery_failed: 'discover', discovery_invalid: 'discover', token_exchange_failed: 'token', jwks_unavailable: 'jwks',
  token_invalid: 'verify', claims_invalid: 'verify', email_unverified: 'verify', dataset_mismatch: 'verify', role_unknown: 'verify'
};

const MESSAGES: Record<AuthErrorCode, string> = {
  invalid_config: 'Sign-in settings are invalid.',
  discovery_failed: 'The sign-in provider could not be reached.',
  discovery_invalid: 'The sign-in provider returned an unacceptable configuration.',
  transaction_invalid: 'The sign-in attempt is missing or invalid.',
  transaction_expired: 'The sign-in attempt expired.',
  state_mismatch: 'The sign-in response did not match the attempt.',
  provider_error: 'The sign-in provider refused the request.',
  issuer_mismatch: 'The sign-in response came from an unexpected provider.',
  invalid_callback: 'The sign-in response is malformed.',
  token_exchange_failed: 'The sign-in code could not be exchanged.',
  jwks_unavailable: 'The provider signing keys could not be loaded.',
  token_invalid: 'The identity token was not accepted.',
  claims_invalid: 'The identity token has unacceptable claims.',
  email_unverified: 'The account email is not verified.',
  dataset_mismatch: 'The identity token is for a different dataset.',
  role_unknown: 'The identity token has an unknown role.'
};

export class CraftAuthError extends Error {
  readonly code: AuthErrorCode;
  /** Which part of the sign-in failed, for log lines. */
  readonly step: AuthStep;
  constructor(code: AuthErrorCode) {
    super(MESSAGES[code]);
    this.name = 'CraftAuthError';
    this.code = code;
    this.step = STEPS[code];
  }
}

export const authFail = (code: AuthErrorCode): never => { throw new CraftAuthError(code); };
