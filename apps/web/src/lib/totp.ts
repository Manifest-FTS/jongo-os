import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";

/**
 * Time-based one-time codes (RFC 6238) for two-step sign-in: SHA-1, 6 digits,
 * 30-second steps — the settings every authenticator app supports. Pure
 * functions only; storage and replay checks live in lib/two-factor.ts.
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps either side of now that still count, for phone clocks that drift. */
export const TOTP_WINDOW = 1;
export const RECOVERY_CODE_COUNT = 10;
export const TOTP_ISSUER = "Jongo";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("Invalid base32 secret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32 as authenticator apps expect. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The secret in groups of four, for typing into an app by hand. */
export function formatSecretForDisplay(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

export function totpStep(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}

export function totpCodeAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  counter.writeUInt32BE(step >>> 0, 4);
  const digest = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP_DIGITS;
  return String(binary).padStart(TOTP_DIGITS, "0");
}

function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Digits only, so "123 456" and "123-456" both work. */
export function normalizeTotpInput(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const digits = input.replace(/[\s-]/g, "");
  return new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(digits) ? digits : null;
}

/**
 * The step a code matched, or null. A code at or before `lastStep` is refused,
 * so a code seen over someone's shoulder can't be used again.
 */
export function verifyTotp(
  secret: string,
  input: unknown,
  options: { now?: Date; lastStep?: number | null } = {}
): number | null {
  const code = normalizeTotpInput(input);
  if (!code) return null;
  const current = totpStep(options.now);
  let matched: number | null = null;
  // Check every step in the window so timing doesn't reveal which one matched.
  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset += 1) {
    const step = current + offset;
    if (sameString(totpCodeAt(secret, step), code) && matched === null) matched = step;
  }
  if (matched === null) return null;
  if (options.lastStep != null && matched <= options.lastStep) return null;
  return matched;
}

export function otpauthUri(accountEmail: string, secret: string): string {
  const label = `${TOTP_ISSUER}:${accountEmail}`;
  const params = new URLSearchParams({
    secret,
    issuer: TOTP_ISSUER,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS)
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Recovery codes: ten one-use codes like "k7m2q-9xw4r", shown once.

const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o, 1/l/i

function randomRecoveryCode(): string {
  const bytes = randomBytes(10);
  let out = "";
  for (let i = 0; i < 10; i += 1) {
    out += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length];
    if (i === 4) out += "-";
  }
  return out;
}

export function normalizeRecoveryCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const clean = input.toLowerCase().replace(/[\s-]/g, "");
  return /^[a-z0-9]{10}$/.test(clean) ? clean : null;
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(`jongo-recovery:${normalizeRecoveryCode(code) ?? code}`).digest("hex");
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: count }, randomRecoveryCode);
  return { codes, hashes: codes.map(hashRecoveryCode) };
}

/** The stored hash this input matches, or null. */
export function matchRecoveryCode(hashes: readonly string[], input: unknown): string | null {
  const code = normalizeRecoveryCode(input);
  if (!code) return null;
  const candidate = hashRecoveryCode(code);
  let matched: string | null = null;
  for (const hash of hashes) {
    if (sameString(hash, candidate) && matched === null) matched = hash;
  }
  return matched;
}
