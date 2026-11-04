import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

/**
 * Encryption for secrets stored in the database (GitHub App credentials,
 * WordPress application passwords).
 *
 * v2 (current): `v2:<kid>:<iv>:<tag>:<ciphertext>`, AES-256-GCM with a
 * dedicated 32-byte key from SECRETS_ENCRYPTION_KEY (base64 or hex). `kid` is
 * the first 8 hex chars of sha256(key), so a rotated key can sit beside the old
 * one in SECRETS_ENCRYPTION_KEY_PREVIOUS until everything is re-encrypted
 * (scripts/reencrypt-secrets.mjs).
 *
 * v1 (legacy, read-only): `v1:<iv>:<tag>:<ciphertext>`, key = sha256 of
 * WORDPRESS_TELEMETRY_ENCRYPTION_SECRET or NEXTAUTH_SECRET. Still decrypted so
 * existing rows keep working; never written in production. The hard-coded
 * development fallback is only ever used outside production.
 *
 * Production fails closed: without SECRETS_ENCRYPTION_KEY nothing new is
 * encrypted, rather than encrypting with a key derived from the session secret
 * (which made rotating NEXTAUTH_SECRET destroy stored secrets) or a public one.
 */

const ALGORITHM = "aes-256-gcm";
const DEV_ONLY_LEGACY_SECRET = "dev-only-wordpress-telemetry-secret";

export class SecretKeyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretKeyConfigError";
  }
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Parse a 32-byte key given as base64 or 64 hex characters. */
export function parseEncryptionKey(raw: string, name = "SECRETS_ENCRYPTION_KEY"): Buffer {
  const value = raw.trim();
  const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new SecretKeyConfigError(`${name} must be 32 random bytes, as base64 or 64 hex characters.`);
  }
  return key;
}

export function keyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

function configuredKeys(): { current: Buffer | null; all: Map<string, Buffer> } {
  const all = new Map<string, Buffer>();
  const currentRaw = process.env.SECRETS_ENCRYPTION_KEY?.trim();
  const current = currentRaw ? parseEncryptionKey(currentRaw) : null;
  if (current) all.set(keyId(current), current);
  const previousRaw = process.env.SECRETS_ENCRYPTION_KEY_PREVIOUS?.trim();
  if (previousRaw) {
    const previous = parseEncryptionKey(previousRaw, "SECRETS_ENCRYPTION_KEY_PREVIOUS");
    all.set(keyId(previous), previous);
  }
  return { current, all };
}

function legacyKey(): Buffer {
  const secret =
    process.env.WORDPRESS_TELEMETRY_ENCRYPTION_SECRET?.trim() ||
    process.env.NEXTAUTH_SECRET?.trim() ||
    (isProduction() ? "" : DEV_ONLY_LEGACY_SECRET);
  if (!secret) {
    throw new SecretKeyConfigError("No key is configured to read this stored secret.");
  }
  return createHash("sha256").update(secret).digest();
}

function seal(key: Buffer, plaintext: string): { iv: string; tag: string; data: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

function open(key: Buffer, iv: string, tag: string, data: string): string {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

export function encryptSecret(value: string): string {
  const plaintext = value.trim();
  if (!plaintext) {
    throw new Error("Cannot encrypt an empty secret");
  }

  const { current } = configuredKeys();
  if (current) {
    const box = seal(current, plaintext);
    return ["v2", keyId(current), box.iv, box.tag, box.data].join(":");
  }

  if (isProduction()) {
    throw new SecretKeyConfigError("SECRETS_ENCRYPTION_KEY is not set, so this secret can't be stored safely.");
  }

  // Local development without a key: legacy format so nothing extra is needed.
  const box = seal(legacyKey(), plaintext);
  return ["v1", box.iv, box.tag, box.data].join(":");
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(":");

  if (parts[0] === "v2" && parts.length === 5 && parts.every(Boolean)) {
    const [, kid, iv, tag, data] = parts;
    const key = configuredKeys().all.get(kid);
    if (!key) {
      throw new SecretKeyConfigError(`No configured key matches stored secret key id ${kid}.`);
    }
    return open(key, iv, tag, data);
  }

  if (parts[0] === "v1" && parts.length === 4 && parts.every(Boolean)) {
    const [, iv, tag, data] = parts;
    return open(legacyKey(), iv, tag, data);
  }

  throw new Error("Unsupported secret payload format");
}

/** True when a stored value should be rewritten with the current key. */
export function needsReencryption(payload: string): boolean {
  const { current } = configuredKeys();
  if (!current) return false;
  const parts = payload.split(":");
  return !(parts[0] === "v2" && parts[1] === keyId(current));
}
