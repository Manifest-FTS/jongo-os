/**
 * Constant-time string comparison for secrets (bearer tokens, setup tokens).
 *
 * `a === b` returns as soon as a character differs, so response timing reveals
 * how much of a guessed token was right. This always walks the longer input and
 * folds every difference into one value.
 *
 * Pure JS on purpose: middleware runs on the edge runtime, which has no
 * node:crypto `timingSafeEqual`. Only the length of the longer input can leak,
 * which says nothing useful about a random token.
 *
 * Empty or missing values never match, so an unset secret can't be satisfied
 * by sending an empty header.
 */
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}
