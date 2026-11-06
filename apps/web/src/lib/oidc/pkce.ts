import { createHash, timingSafeEqual } from "node:crypto";

/** RFC 7636: S256 is the only accepted method; `plain` and a missing challenge are rejected. */
export const CODE_CHALLENGE_METHOD = "S256";

const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

export function isValidCodeChallenge(value: unknown): value is string {
  return typeof value === "string" && CHALLENGE.test(value);
}

export function isValidCodeVerifier(value: unknown): value is string {
  return typeof value === "string" && VERIFIER.test(value);
}

export function s256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function verifyPkceS256(verifier: unknown, challenge: unknown): boolean {
  if (!isValidCodeVerifier(verifier) || !isValidCodeChallenge(challenge)) return false;
  const computed = Buffer.from(s256Challenge(verifier));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}
