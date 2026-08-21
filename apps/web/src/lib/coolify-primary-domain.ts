/**
 * The domain a Coolify resource is actually served on.
 *
 * The app's overview showed a "Primary domain" it had BUILT itself, from the
 * workspace slug and the temporary-domain suffix. That is the address a site
 * gets before anyone points a real domain at it — so every site with a real
 * domain displayed the wrong one, and nothing on the page ever consulted
 * Coolify.
 *
 * Reading it is not quite as simple as `resource.fqdn`. For the WordPress
 * services on this platform that field is UNDEFINED; the domain lives on the
 * nested application:
 *
 *   service.fqdn                 -> undefined
 *   service.applications[0].fqdn -> "https://teach.lgbt/"
 *                                -> "https://a.example.com,https://b.example.com"
 *
 * so it can be missing, carry a scheme, a trailing slash, and several
 * comma-separated hosts at once. The FIRST entry is the primary — that is the
 * order Coolify stores and Traefik matches in.
 */

/** Strip scheme, path, port and trailing dot; lowercase. Empty when unusable. */
export function normalizeDomain(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  // Guard against `new URL("https://42")`, which parses a bare integer as the
  // IPv4 address 0.0.0.42 — so a numeric id would render as a domain. Require a
  // dot in the host segment itself; real hostnames and real IPs both have one.
  const hostSegment = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0].split(":")[0];
  if (!hostSegment.includes(".")) return "";

  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

/** Every domain on a resource, in Coolify's own order. */
export function extractResourceDomains(resource: unknown): string[] {
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) return [];
  const record = resource as Record<string, unknown>;

  const raw: unknown[] = [record.fqdn, record.domains, record.domain, record.url];

  // Services keep the real address on the application inside them.
  const applications = record.applications;
  if (Array.isArray(applications)) {
    for (const app of applications) {
      if (app && typeof app === "object" && !Array.isArray(app)) {
        raw.push((app as Record<string, unknown>).fqdn);
      }
    }
  }

  const out: string[] = [];
  for (const entry of raw) {
    if (entry === null || entry === undefined) continue;
    const parts = Array.isArray(entry) ? entry : String(entry).split(",");
    for (const part of parts) {
      const host = normalizeDomain(part);
      // De-duplicated: a resource routinely repeats the same host across fields,
      // and "primary" must be the first DISTINCT one.
      if (host && !out.includes(host)) out.push(host);
    }
  }
  return out;
}

/** The address to show as primary, or empty when Coolify has none. */
export function extractPrimaryDomain(resource: unknown): string {
  return extractResourceDomains(resource)[0] ?? "";
}
