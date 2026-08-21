/**
 * Purging Cloudflare's edge cache as a fourth flush target.
 *
 * Jongo's Flush Cache clears three caches that all live inside the container.
 * None of them reach a CDN, so for a site behind Cloudflare the button could
 * report everything flushed while the public URL still served a stale copy from
 * the edge — the exact case hit on gardenstateequality.org, where the only
 * remaining option was a manual purge in the Cloudflare dashboard.
 *
 * ## No per-site configuration
 *
 * The zone is DISCOVERED from the site's own primary domain rather than stored
 * per site. A token is account-wide, and Jongo already knows what domain
 * Coolify serves each app on, so asking an operator to paste a zone id per site
 * across a 46-site fleet would be work with no information in it — and one more
 * field to go stale when a domain changes.
 *
 * A site that is not on Cloudflare simply resolves no zone, which is reported
 * as `absent` — the same way a site with no Redis is. It is not a failure.
 *
 * ## Blast radius
 *
 * The purge is `purge_everything` for the resolved zone. Purging by hostname is
 * an Enterprise-only feature, so it is not available to most accounts. That
 * means if one Cloudflare zone fronts several apps — several subdomains of one
 * domain, say — flushing one app purges the edge cache for all of them. Nothing
 * is lost (caches refill from origin) but the others briefly serve slower. The
 * zone that gets purged is named in the result so this is visible rather than
 * surprising.
 */

export type CloudflareConfig = {
  apiToken: string;
  /** Pins every purge to one zone, for a single-zone install. */
  pinnedZoneId: string;
};

export function readCloudflareConfig(): CloudflareConfig | null {
  const apiToken = (process.env.CLOUDFLARE_API_TOKEN || "").trim();
  if (!apiToken) return null;
  return { apiToken, pinnedZoneId: (process.env.CLOUDFLARE_ZONE_ID || "").trim() };
}

export function isCloudflareConfigured(): boolean {
  return readCloudflareConfig() !== null;
}

/**
 * The zone names to try for a hostname, most specific first.
 *
 * A zone is registered at the apex (`example.com`) but a site is commonly served
 * from a subdomain (`www.example.com`, `shop.a.example.com`), so the apex has to
 * be found by walking up. Most specific first because Cloudflare allows a
 * subdomain to be its own zone, and that zone — not the parent — is the one
 * holding the cache for it.
 *
 * The last label pair is the shortest candidate: a single label ("com") is never
 * a zone anyone owns, and asking about it wastes a call.
 */
export function zoneCandidates(hostname: string): string[] {
  const host = String(hostname ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!host || !host.includes(".")) return [];
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return [];

  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i += 1) {
    out.push(labels.slice(i).join("."));
  }
  return out;
}

const TIMEOUT_MS = 10_000;
const API = "https://api.cloudflare.com/client/v4";

async function cf(
  config: CloudflareConfig,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${API}${path}`, {
      ...init,
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {})
      }
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  } finally {
    clearTimeout(timer);
  }
}

export type CloudflarePurgeResult =
  /** Purged. `zone` is what was purged, so a shared zone is visible. */
  | { status: "flushed"; zone: string }
  /** Not on Cloudflare, or Cloudflare is not configured. Not an error. */
  | { status: "absent"; reason: string }
  /** There is a zone and the purge did not work. */
  | { status: "failed"; reason: string };

/** Find the zone id serving `hostname`, or null when Cloudflare has none. */
export async function resolveZoneId(
  config: CloudflareConfig,
  hostname: string
): Promise<{ id: string; name: string } | null> {
  if (config.pinnedZoneId) return { id: config.pinnedZoneId, name: hostname };

  for (const candidate of zoneCandidates(hostname)) {
    const { status, body } = await cf(config, `/zones?name=${encodeURIComponent(candidate)}&status=active`);
    if (status !== 200 || !body?.success) continue;
    const zone = Array.isArray(body.result) ? body.result[0] : null;
    if (zone?.id) return { id: String(zone.id), name: String(zone.name ?? candidate) };
  }
  return null;
}

/**
 * Purge the edge cache for the zone serving this site.
 *
 * Every "cannot" answer is `absent`, not `failed`: a site with no Cloudflare in
 * front of it must not turn a successful local flush into a reported failure.
 * `failed` is reserved for the case where a zone WAS found and the purge did not
 * happen — the one case where the page may still be stale afterwards.
 */
export async function purgeCloudflareCache(hostname: string): Promise<CloudflarePurgeResult> {
  const config = readCloudflareConfig();
  if (!config) return { status: "absent", reason: "not_configured" };

  const host = String(hostname ?? "").trim();
  if (!host) return { status: "absent", reason: "no_domain" };

  let zone: { id: string; name: string } | null;
  try {
    zone = await resolveZoneId(config, host);
  } catch {
    return { status: "failed", reason: "zone_lookup_failed" };
  }
  if (!zone) return { status: "absent", reason: "no_zone_for_domain" };

  try {
    const { status, body } = await cf(config, `/zones/${encodeURIComponent(zone.id)}/purge_cache`, {
      method: "POST",
      body: JSON.stringify({ purge_everything: true })
    });
    if (status === 200 && body?.success) return { status: "flushed", zone: zone.name };

    const detail = Array.isArray(body?.errors) && body.errors[0]?.message ? String(body.errors[0].message) : `http_${status}`;
    return { status: "failed", reason: detail.slice(0, 200) };
  } catch {
    return { status: "failed", reason: "purge_request_failed" };
  }
}
