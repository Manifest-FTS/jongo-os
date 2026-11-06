import { createHash, createHmac, timingSafeEqual } from "node:crypto";

type ConsentStore = {
  oidcConsent: {
    findUnique(args: { where: { userId_oidcClientId: { userId: string; oidcClientId: string } } }): Promise<{ scope: string; revokedAt: Date | null } | null>;
    upsert(args: Record<string, unknown>): Promise<unknown>;
  };
};

/** True only when an unrevoked consent already covers every requested scope. */
export async function hasConsent(db: ConsentStore, userId: string, oidcClientId: string, scopes: readonly string[]): Promise<boolean> {
  const row = await db.oidcConsent.findUnique({ where: { userId_oidcClientId: { userId, oidcClientId } } });
  if (!row || row.revokedAt !== null) return false;
  const granted = new Set(row.scope.split(" "));
  return scopes.every((scope) => granted.has(scope));
}

export async function recordConsent(db: ConsentStore, userId: string, oidcClientId: string, scopes: readonly string[], now = new Date()): Promise<void> {
  const scope = scopes.join(" ");
  await db.oidcConsent.upsert({
    where: { userId_oidcClientId: { userId, oidcClientId } },
    create: { userId, oidcClientId, scope, grantedAt: now },
    update: { scope, grantedAt: now, revokedAt: null }
  });
}

/** The exact authorization request a consent decision applies to. */
export type ConsentBinding = {
  userId: string;
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  scope: string;
};

const CONSENT_TTL_SECONDS = 600;

function requestHash(binding: ConsentBinding): string {
  return createHash("sha256")
    .update(JSON.stringify([binding.clientId, binding.redirectUri, binding.state, binding.nonce, binding.codeChallenge, binding.scope]))
    .digest("hex");
}

function mac(secret: Buffer, binding: ConsentBinding, expiresAt: number): string {
  return createHmac("sha256", secret)
    .update(`consent-v1|${binding.userId}|${expiresAt}|${requestHash(binding)}`)
    .digest("base64url");
}

/** Expiring HMAC bound to the signed-in user and the exact request; not an authenticator by itself. */
export function signConsentToken(secret: Buffer, binding: ConsentBinding, now = new Date()): string {
  const expiresAt = Math.floor(now.getTime() / 1000) + CONSENT_TTL_SECONDS;
  return `${expiresAt}.${mac(secret, binding, expiresAt)}`;
}

export function verifyConsentToken(secret: Buffer, binding: ConsentBinding, token: unknown, now = new Date()): boolean {
  if (typeof token !== "string") return false;
  const [expiresRaw, provided, ...rest] = token.split(".");
  if (rest.length > 0 || !/^\d{1,12}$/.test(expiresRaw ?? "") || !provided) return false;
  const expiresAt = Number(expiresRaw);
  if (expiresAt <= Math.floor(now.getTime() / 1000)) return false;
  const expected = Buffer.from(mac(secret, binding, expiresAt));
  const actual = Buffer.from(provided);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
