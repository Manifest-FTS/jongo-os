/**
 * The one place that decides which secret signs and verifies sessions.
 *
 * Production fails CLOSED: a missing NEXTAUTH_SECRET, or the old placeholder
 * value, yields no secret at all, so nothing can be signed or verified and every
 * protected route refuses access. Previously the same misconfiguration turned
 * authentication off entirely, and NextAuth would have signed sessions with a
 * string that is public in this repository.
 *
 * Local development keeps working without a secret: the placeholder is used,
 * and the dev auto-sign-in in lib/auth.config.ts stays available — but only
 * when NODE_ENV is not "production".
 *
 * Edge-safe (middleware imports it): reads process.env only.
 */

export const DEV_PLACEHOLDER_AUTH_SECRET = "dev-secret-change-in-production";

function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production";
}

function configuredSecret(): string | null {
  const value = process.env.NEXTAUTH_SECRET?.trim();
  if (!value || value === DEV_PLACEHOLDER_AUTH_SECRET) return null;
  return value;
}

/** The signing secret, or null when production has no usable one. */
export function resolveAuthSecret(): string | null {
  const secret = configuredSecret();
  if (secret) return secret;
  return isProductionRuntime() ? null : DEV_PLACEHOLDER_AUTH_SECRET;
}

/**
 * True only in local development with no real secret configured. Never true
 * in production, whatever the environment variables say.
 */
export function isDevAuthBypassEnabled(): boolean {
  return !isProductionRuntime() && configuredSecret() === null;
}
