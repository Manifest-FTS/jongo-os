import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * GitHub signs every webhook body with the app's webhook secret
 * (X-Hub-Signature-256: "sha256=<hex>"). Checked before any work is done, in
 * constant time; anything missing, legacy (sha1) or malformed is refused.
 */
export function verifyGithubSignature(rawBody: string, header: string | null | undefined, secret: string): boolean {
  if (!secret || !header || !header.startsWith("sha256=")) return false;
  const provided = Buffer.from(header.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
