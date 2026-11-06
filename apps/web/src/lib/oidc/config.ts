/**
 * Sign in with Jongo (OIDC provider) configuration.
 *
 * Everything is off unless JONGO_OIDC_ENABLED is exactly the string "true". When
 * enabled, a missing or malformed setting FAILS CLOSED: the routes answer 503 and
 * diagnostics name the variable only, never its value.
 */

export const OIDC_ENV = {
  enabled: "JONGO_OIDC_ENABLED",
  issuer: "JONGO_OIDC_ISSUER",
  signingKey: "JONGO_OIDC_SIGNING_KEY",
  previousPublicKeys: "JONGO_OIDC_PREVIOUS_PUBLIC_KEYS"
} as const;

export const ID_TOKEN_TTL_SECONDS = 300;
export const AUTH_CODE_TTL_SECONDS = 60;
export const SUPPORTED_SCOPES = ["openid", "email", "profile", "craft"] as const;

type Env = Record<string, string | undefined>;

export type OidcConfig = {
  issuer: string;
  signingKey: string;
  previousPublicKeys: string | null;
};

export type OidcConfigResult =
  | { ok: true; config: OidcConfig }
  | { ok: false; problems: string[] };

export function isOidcEnabled(env: Env = process.env): boolean {
  return env[OIDC_ENV.enabled] === "true";
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Returns the normalized origin, or null when the value is not an acceptable issuer. */
export function normalizeIssuer(raw: string, production: boolean): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && !production && isLoopbackHost(url.hostname)) return url.origin;
  return null;
}

export function readOidcConfig(env: Env = process.env): OidcConfigResult {
  const problems: string[] = [];
  const production = env.NODE_ENV === "production";

  const issuerRaw = env[OIDC_ENV.issuer]?.trim();
  let issuer = "";
  if (!issuerRaw) problems.push(`${OIDC_ENV.issuer}: missing`);
  else {
    const normalized = normalizeIssuer(issuerRaw, production);
    if (!normalized) problems.push(`${OIDC_ENV.issuer}: invalid`);
    else issuer = normalized;
  }

  const signingKey = env[OIDC_ENV.signingKey]?.trim() ?? "";
  if (!signingKey) problems.push(`${OIDC_ENV.signingKey}: missing`);

  // Authorize relies on auth(), which has a development bypass when the secret is unset.
  const secret = env.NEXTAUTH_SECRET;
  if (production && (!secret || secret === "dev-secret-change-in-production")) {
    problems.push("NEXTAUTH_SECRET: missing or default in production");
  }

  if (problems.length > 0) return { ok: false, problems };
  const previous = env[OIDC_ENV.previousPublicKeys]?.trim();
  return { ok: true, config: { issuer, signingKey, previousPublicKeys: previous ? previous : null } };
}
