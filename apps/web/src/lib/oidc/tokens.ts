import { randomUUID } from "node:crypto";
import { SignJWT, createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from "jose";
import { ID_TOKEN_TTL_SECONDS } from "./config";
import type { OidcKeys } from "./keys";

export type CraftClaim = {
  dataset: string;
  role: "reader" | "editor" | "publisher" | "admin";
  siteId?: string;
  via: "platform_admin" | "org_owner" | "org_admin" | "site_grant";
};

export type IdTokenInput = {
  issuer: string;
  clientId: string;
  subject: string;
  nonce: string;
  authTime: Date;
  scopes: readonly string[];
  email: string;
  emailVerified: boolean;
  name: string | null;
  craft: CraftClaim;
  now?: Date;
};

/** The `craft` claim is always present: it is the reason this client exists. email/name follow scope. */
export async function signIdToken(keys: OidcKeys, input: IdTokenInput): Promise<string> {
  const issuedAt = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const claims: JWTPayload = {
    nonce: input.nonce,
    auth_time: Math.floor(input.authTime.getTime() / 1000),
    craft: input.craft
  };
  if (input.scopes.includes("email")) {
    claims.email = input.email;
    claims.email_verified = input.emailVerified;
  }
  if (input.scopes.includes("profile") && input.name) claims.name = input.name;

  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: keys.kid, typ: "JWT" })
    .setIssuer(input.issuer)
    .setSubject(input.subject)
    .setAudience(input.clientId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ID_TOKEN_TTL_SECONDS)
    .setJti(randomUUID())
    .sign(keys.signingKey);
}

export type VerifyIdTokenOptions = {
  issuer: string;
  audience: string;
  nonce?: string;
  jwks: { keys: Array<Record<string, unknown>> };
  now?: Date;
  clockToleranceSeconds?: number;
};

/**
 * Reference verifier (what a relying party must do). Only EdDSA is accepted: `none`,
 * HMAC and RS256 are rejected, and the key is chosen by `kid` from the supplied set only.
 */
export async function verifyIdToken(token: string, options: VerifyIdTokenOptions): Promise<JWTPayload> {
  const tolerance = options.clockToleranceSeconds ?? 60;
  const header = decodeProtectedHeader(token);
  if (header.alg !== "EdDSA") throw new Error("unsupported alg");
  if (typeof header.kid !== "string" || !header.kid) throw new Error("missing kid");

  const { payload } = await jwtVerify(token, createLocalJWKSet(options.jwks as never), {
    algorithms: ["EdDSA"],
    issuer: options.issuer,
    audience: options.audience,
    currentDate: options.now,
    clockTolerance: tolerance,
    requiredClaims: ["iss", "sub", "aud", "exp", "iat", "nonce"]
  });

  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const iat = payload.iat as number;
  if (iat > nowSeconds + tolerance) throw new Error("iat in the future");
  if (iat < nowSeconds - ID_TOKEN_TTL_SECONDS - tolerance) throw new Error("iat too old");
  if (options.nonce !== undefined && payload.nonce !== options.nonce) throw new Error("nonce mismatch");
  return payload;
}
