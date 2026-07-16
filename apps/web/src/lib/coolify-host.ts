/**
 * Host helpers for Coolify resources.
 *
 * Kept dependency-free so it can be unit tested without pulling in the rest of
 * the Coolify client.
 */

/**
 * A Coolify one-click service mints its own hostname at creation time as
 * `{composeServiceName}-{serviceUuid}.{wildcard}` and stores it as SERVICE_FQDN_*.
 * Writing that host into WordPress `siteurl`/`home` makes the site self-identify
 * as the generated host permanently, so callers must never treat it as a
 * preferred domain.
 *
 * Pass `serviceUuid` whenever it is known – the check is then exact. The
 * heuristic fallback matches the shape Coolify mints: a trailing cuid2, which
 * is always 24 lowercase alphanumerics beginning with a letter.
 */
export function isGeneratedCoolifyHost(value: string, serviceUuid?: string): boolean {
  const host = (() => {
    try {
      return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();

  const label = host.split(".")[0] ?? "";
  if (!label) {
    return false;
  }

  if (serviceUuid) {
    return label.endsWith(`-${serviceUuid.trim().toLowerCase()}`);
  }

  return /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-z][a-z0-9]{23}$/.test(label);
}
