/**
 * Production domains: which attached host is the primary (the address
 * WordPress saves and every link uses), which are fallbacks (Jongo's own
 * address, e.g. fuscarino.manifest-fts.com), and the small WordPress plugin
 * that keeps the fallback working if the client's domain stops resolving.
 *
 * Pure, so every rule is a test. The I/O is in production-domains.ts.
 */
import { DEFAULT_BLOCKED_SUFFIXES } from "./staging-domain-rules";

/** A hostname safe to place, unescaped, inside generated PHP and shell. */
const SAFE_HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function isSafeHost(host: string): boolean {
  return SAFE_HOST.test(host);
}

/** Jongo's own address (always works), as opposed to the client's domain. */
export function isFallbackHost(host: string, platformSuffixes: string[] = []): boolean {
  const h = host.toLowerCase();
  return [...DEFAULT_BLOCKED_SUFFIXES, ...platformSuffixes]
    .map((suffix) => suffix.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean)
    .some((suffix) => h === suffix || h.endsWith(`.${suffix}`));
}

/**
 * The primary among the attached hosts: the saved choice while it is still
 * attached, else the first client domain, else the first host (a site with
 * only a Jongo address).
 */
export function choosePrimary(hosts: string[], saved: string | null | undefined, platformSuffixes: string[] = []): string | null {
  const list = dedupe(hosts);
  if (list.length === 0) return null;
  const want = saved?.trim().toLowerCase();
  if (want && list.includes(want)) return want;
  return list.find((host) => !isFallbackHost(host, platformSuffixes)) ?? list[0];
}

/** Primary first (the order Coolify and Traefik treat as the main URL), the rest kept. */
export function orderHosts(hosts: string[], primary: string): string[] {
  const list = dedupe(hosts);
  const p = primary.trim().toLowerCase();
  return list.includes(p) ? [p, ...list.filter((host) => host !== p)] : list;
}

function dedupe(hosts: string[]): string[] {
  return [...new Set(hosts.map((host) => host.trim().toLowerCase()).filter(Boolean))];
}

export type DomainRow = { host: string; primary: boolean; fallback: boolean };

export function describeHosts(hosts: string[], primary: string | null, platformSuffixes: string[] = []): DomainRow[] {
  return dedupe(hosts).map((host) => ({ host, primary: host === primary, fallback: isFallbackHost(host, platformSuffixes) }));
}

export const FALLBACK_PLUGIN_FILE = "jongo-fallback-address.php";

/**
 * A must-use plugin. On a request to a fallback host it serves the site on
 * that host instead of redirecting to the saved (primary) address, rewrites
 * links in the page to match, and asks search engines not to index the
 * duplicate. On the primary host it does nothing. The database keeps the
 * primary address throughout.
 *
 * Returns null when there is nothing to do (no fallback distinct from the
 * primary): the caller removes the plugin.
 */
export function buildFallbackPlugin(primary: string, fallbacks: string[]): string | null {
  const p = primary.trim().toLowerCase();
  const list = dedupe(fallbacks).filter((host) => host !== p);
  if (list.length === 0) return null;
  for (const host of [p, ...list]) {
    if (!isSafeHost(host)) throw new Error(`Unsafe hostname: ${host}`);
  }
  const array = list.map((host) => `'${host}'`).join(", ");
  return `<?php
/**
 * Plugin Name: Jongo fallback address
 * Description: Managed by Jongo. Keeps this site working on its backup address (${list.join(", ")}) if ${p} is unavailable. Changes here are overwritten.
 */
if (!defined('ABSPATH')) { return; }
$jongo_primary = '${p}';
$jongo_fallbacks = array(${array});
$jongo_host = isset($_SERVER['HTTP_HOST']) ? strtolower(preg_replace('/:\\d+$/', '', (string) $_SERVER['HTTP_HOST'])) : '';
if ($jongo_host === '' || !in_array($jongo_host, $jongo_fallbacks, true)) { return; }
$jongo_swap = function ($value) use ($jongo_primary, $jongo_host) {
  return is_string($value) ? str_ireplace('//' . $jongo_primary, '//' . $jongo_host, $value) : $value;
};
add_filter('option_home', $jongo_swap, 1);
add_filter('option_siteurl', $jongo_swap, 1);
add_filter('redirect_canonical', '__return_false');
add_action('send_headers', function () { header('X-Robots-Tag: noindex, nofollow', true); });
add_action('template_redirect', function () use ($jongo_swap) { ob_start($jongo_swap); }, 0);
`;
}
