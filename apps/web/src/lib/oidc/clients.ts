import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type OidcClientRecord = {
  id: string;
  clientId: string;
  organizationId: string;
  siteId: string;
  name: string;
  datasetName: string;
  status: "active" | "disabled";
  secretHash: string;
  previousSecretHash: string | null;
  previousSecretExpiresAt: Date | null;
  redirectUris: string[];
  allowedOrigins: string[];
};

export function generateClientId(): string {
  return `jc_${randomBytes(16).toString("base64url")}`;
}

/** 256 bits of entropy: a salted fast hash is sufficient, a password KDF would only slow the token endpoint. */
export function generateClientSecret(): string {
  return `jcs_${randomBytes(32).toString("base64url")}`;
}

function digest(salt: Buffer, secret: string): Buffer {
  return createHmac("sha256", salt).update(secret, "utf8").digest();
}

/** Stored as "v1$<salt>$<hash>" (base64url, per-secret random salt). */
export function hashClientSecret(secret: string): string {
  const salt = randomBytes(16);
  return `v1$${salt.toString("base64url")}$${digest(salt, secret).toString("base64url")}`;
}

const DUMMY_SALT = Buffer.alloc(16, 1);
const DUMMY_HASH = digest(DUMMY_SALT, "dummy");

/** Constant-time; malformed stored values compare against a dummy so timing does not reveal them. */
export function verifyClientSecret(secret: string, stored: string | null | undefined): boolean {
  const parts = typeof stored === "string" ? stored.split("$") : [];
  const wellFormed = parts.length === 3 && parts[0] === "v1";
  const salt = wellFormed ? Buffer.from(parts[1], "base64url") : DUMMY_SALT;
  const expected = wellFormed ? Buffer.from(parts[2], "base64url") : DUMMY_HASH;
  const actual = digest(salt, secret);
  const sameLength = actual.length === expected.length;
  const equal = timingSafeEqual(actual, sameLength ? expected : DUMMY_HASH);
  return wellFormed && sameLength && equal;
}

/** Accepts the current secret, or the previous one until its overlap window closes. */
export function authenticateClientSecret(client: OidcClientRecord, secret: string, now: Date = new Date()): boolean {
  const current = verifyClientSecret(secret, client.secretHash);
  const previousLive = client.previousSecretHash !== null && client.previousSecretExpiresAt !== null &&
    client.previousSecretExpiresAt.getTime() > now.getTime();
  const previous = verifyClientSecret(secret, previousLive ? client.previousSecretHash : null);
  return current || previous;
}

/** Exact string equality: no normalization, no case folding, no trailing-slash tolerance. */
export function redirectUriMatches(registered: readonly string[], candidate: unknown): candidate is string {
  return typeof candidate === "string" && candidate.length > 0 && registered.includes(candidate);
}

export type RedirectUriCheck = { ok: true } | { ok: false; reason: string };

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Registration-time rules: https only (loopback http outside production), no fragment, userinfo or wildcard. */
export function checkRedirectUriForRegistration(uri: string, allowedOrigins: readonly string[], production: boolean): RedirectUriCheck {
  if (uri.length === 0 || uri.length > 2048 || /[\s*\u0000-\u001f\\]/.test(uri)) return { ok: false, reason: "malformed" };
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (url.hash || uri.includes("#")) return { ok: false, reason: "fragment" };
  if (url.username || url.password) return { ok: false, reason: "userinfo" };
  const secure = url.protocol === "https:" || (url.protocol === "http:" && !production && isLoopback(url.hostname));
  if (!secure) return { ok: false, reason: "insecure" };
  if (!allowedOrigins.includes(url.origin)) return { ok: false, reason: "origin_not_allowed" };
  return { ok: true };
}

type ClientStore = {
  oidcClient: {
    findUnique(args: { where: { clientId: string } }): Promise<OidcClientRecord | null>;
  };
};

const CLIENT_ID_SHAPE = /^jc_[A-Za-z0-9_-]{22}$/;

export function isClientIdShape(value: unknown): value is string {
  return typeof value === "string" && CLIENT_ID_SHAPE.test(value);
}

/** Active clients only; an unknown, malformed or disabled id is indistinguishable to the caller. */
export async function findActiveClient(db: ClientStore, clientId: unknown): Promise<OidcClientRecord | null> {
  if (!isClientIdShape(clientId)) return null;
  const client = await db.oidcClient.findUnique({ where: { clientId } });
  return client && client.status === "active" ? client : null;
}
