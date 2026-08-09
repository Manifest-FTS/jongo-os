/**
 * The staging URL for a site: the site's label, then `stage`, then the platform
 * domain — site.stage.example.com.
 *
 * This replaces a slug-plus-suffix template that built staging hostnames out of
 * the Coolify resource slug — which produced things like
 * `wordpress-with-mariadb-xilqqxd9cqmtk47axxo9uvel.staging.mfts.link`, a name
 * nobody could relate to the site it belonged to. Deriving from the production
 * domain means the staging URL always reads as "this site, but staging".
 *
 * Two rules that are not obvious:
 *
 * 1. When a site has several production domains — most do, typically an apex, a
 *    www alias and a platform alias — the PLATFORM alias wins. That is not an
 *    aesthetic choice: the platform domain is wildcard-DNS'd to this server, so
 *    the staging URL resolves the moment it is created. Prefixing a customer's
 *    own domain would produce a URL that 404s until that customer adds a DNS
 *    record, which makes staging feel broken through no fault of the platform.
 *
 * 2. A production host that is itself auto-generated (carrying a resource id)
 *    is still used. The id in the resulting staging URL is inherited from
 *    production, so the fix is to give the site a real domain — not to invent a
 *    hostname here that corresponds to nothing.
 */

export type StageDomainResult = {
  /** The staging host, without scheme. Empty when none could be derived. */
  host: string;
  /** Which production host it was built from. */
  from: string;
  reason: "platform_alias" | "only_domain" | "shortest" | "already_stage" | "none";
};

export const STAGE_PREFIX = "stage";

/**
 * The `stage` label sits before the platform domain rather than in front of the
 * whole production host. Cloudflare's Universal SSL covers example.com and
 * *.example.com and nothing deeper, so stage.site.example.com resolves in DNS
 * and then fails the TLS handshake with no certificate at all. Nesting instead
 * of prefixing means a single *.stage.example.com record covers every site.
 *
 * @param productionHosts every domain Coolify reports for the production resource
 * @param platformSuffixes domains the platform controls DNS for, most specific first
 */
export function deriveStageDomain(
  productionHosts: Array<string | null | undefined>,
  platformSuffixes: Array<string | null | undefined> = []
): StageDomainResult {
  const hosts = normalizeHosts(productionHosts);
  if (hosts.length === 0) {
    return { host: "", from: "", reason: "none" };
  }

  // Already a staging host — never build a second stage label into it.
  const existingStage = hosts.find(
    (h) => h === STAGE_PREFIX || h.startsWith(`${STAGE_PREFIX}.`) || h.includes(`.${STAGE_PREFIX}.`)
  );
  if (existingStage) {
    return { host: existingStage, from: existingStage, reason: "already_stage" };
  }

  const suffixes = normalizeHosts(platformSuffixes);
  const platform = hosts.filter((h) => suffixes.some((s) => h === s || h.endsWith(`.${s}`)));

  if (platform.length > 0) {
    const chosen = shortest(platform);
    const suffix = suffixes.find((s) => chosen === s || chosen.endsWith(`.${s}`)) ?? "";
    // `stage` goes in as its own label BEFORE the platform domain —
    // site.stage.example.com, not stage.site.example.com.
    //
    // Not cosmetic: Cloudflare's Universal SSL covers example.com and
    // *.example.com, one level only. stage.site.example.com is two labels deep,
    // so the TLS handshake fails outright with no certificate — DNS resolves
    // and the site is simply unreachable. This shape matches a single
    // *.stage.example.com record, which can be served DNS-only so the origin
    // issues its own certificate at any depth.
    const label = chosen === suffix ? "" : chosen.slice(0, chosen.length - suffix.length - 1);
    const host = label ? `${label}.${STAGE_PREFIX}.${suffix}` : `${STAGE_PREFIX}.${suffix}`;
    return { host, from: chosen, reason: "platform_alias" };
  }

  // No platform alias to nest under, so fall back to prefixing the customer's
  // own domain. This needs a DNS record on THEIR side, and inherits whatever
  // certificate depth limits their provider has — which is exactly why a
  // platform alias is preferred above.
  if (hosts.length === 1) {
    return { host: `${STAGE_PREFIX}.${hosts[0]}`, from: hosts[0], reason: "only_domain" };
  }

  // No platform alias: fall back to the most apex-like host, which is the one
  // a human would call the site's address.
  const chosen = shortest(hosts);
  return { host: `${STAGE_PREFIX}.${chosen}`, from: chosen, reason: "shortest" };
}

/** Comma/space separated env value -> list. */
export function parsePlatformSuffixes(value?: string | null): string[] {
  return String(value ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeHosts(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const raw of values) {
    const host = normalizeHost(raw);
    // www is an alias of the same site, never the name to build staging from.
    if (!host || host.startsWith("www.")) continue;
    if (!out.includes(host)) out.push(host);
  }
  return out;
}

function normalizeHost(value: string | null | undefined): string {
  let host = String(value ?? "").trim().toLowerCase();
  if (!host) return "";
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  host = host.split("/")[0].split("?")[0];            // path / query
  host = host.replace(/:\d+$/, "");                   // port
  host = host.replace(/\.+$/, "");                    // trailing dot
  // A bare label with no dot is not a routable site domain.
  return host.includes(".") ? host : "";
}

function shortest(hosts: string[]): string {
  return [...hosts].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
}
