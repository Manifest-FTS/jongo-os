/**
 * Coolify's POST /api/v1/services rejects `docker_compose_raw` unless it is
 * base64 encoded, but GET /api/v1/services/{uuid} hands it back as raw YAML.
 * Copying one to the other verbatim therefore always failed validation, and
 * staging provisioning silently fell through to the one-click `type` branch —
 * which builds a fresh service from a template instead of a copy of
 * production's actual compose. The staging copy stopped being a replica.
 *
 * Encoding defensively rather than unconditionally: if a future Coolify version
 * starts returning it already encoded, encoding twice would produce a service
 * whose compose is a base64 blob, which is worse than the bug being fixed.
 */

/** True when the value decodes to text that looks like the compose we sent. */
export function looksBase64Encoded(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return false;
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    // Re-encoding must reproduce the input, otherwise it was not base64 to
    // begin with — plain words like "services" can pass the charset test.
    if (Buffer.from(decoded, "utf8").toString("base64") !== trimmed) return false;
    return /services\s*:|version\s*:/.test(decoded);
  } catch {
    return false;
  }
}

/** Base64 for Coolify, encoding only if it is not already encoded. */
export function encodeComposeForCoolify(compose: string | null | undefined): string {
  const value = String(compose ?? "");
  if (!value.trim()) return "";
  if (looksBase64Encoded(value)) return value.trim();
  return Buffer.from(value, "utf8").toString("base64");
}
